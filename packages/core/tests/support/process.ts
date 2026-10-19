// biome-ignore-all lint/performance/noAwaitInLoops: process output stream must be read sequentially
import { resolve } from "node:path";
import type { FileSink } from "bun";
import { withBuildTestLock } from "./build-lock.ts";

const CLI_ENTRY = resolve(import.meta.dir, "../../src/cli/index.ts");
const REAPER_ENTRY = resolve(import.meta.dir, "process-reaper.ts");
// Below the 30s timeout of CLI build tests so a hung build is killed (and its
// lock released) before the test runner abandons the test.
const CLI_TIMEOUT_MS = 25_000;

export interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface RunningCli {
  exitCode: Promise<number>;
  getStderr: () => string;
  getStdout: () => string;
  kill: () => void;
  pid: number;
}

export function runCli(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
  }
): Promise<CliResult> {
  return withBuildTestLock(async () => {
    const proc = startCli(args, options);
    let timer: Timer | undefined;
    try {
      const exitCode = await Promise.race([
        proc.exitCode,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`CLI command timed out: ${args.join(" ")}`));
          }, CLI_TIMEOUT_MS);
        }),
      ]);

      return {
        exitCode,
        stderr: proc.getStderr(),
        stdout: proc.getStdout(),
      };
    } finally {
      clearTimeout(timer);
      proc.kill();
    }
  });
}

/**
 * Runs `command` to completion without blocking the event loop, so the test
 * runner can still enforce its own timeout. The child is killed after
 * `timeoutMs`; both pipes are drained concurrently so a full pipe cannot
 * stall it.
 */
export async function runProcess(
  command: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    timeoutMs: number;
  }
): Promise<CliResult> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stderr: "pipe",
    stdout: "pipe",
    timeout: options.timeoutMs,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stderr, stdout };
}

async function collectStream(
  stream: ReadableStream<Uint8Array> | null | undefined,
  onChunk: (chunk: string) => void
): Promise<void> {
  if (!stream) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    onChunk(decoder.decode(value, { stream: true }));
  }

  const flush = decoder.decode();
  if (flush) {
    onChunk(flush);
  }
}

export function startCli(
  args: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
  }
): RunningCli {
  return startProcess([process.execPath, CLI_ENTRY, ...args], options);
}

let reaper: FileSink | undefined;

// `bun test --bail` exits without running afterAll hooks nor process "exit"
// listeners, so a long-lived child (e.g. a `bun --hot` dev server) would
// outlive the test process. A sidecar kills it once this process is gone.
// `line` is `<pid>` for a started child and `-<pid>` for an exited one.
function notifyReaper(line: string): void {
  if (!reaper) {
    const sidecar = Bun.spawn([process.execPath, REAPER_ENTRY], {
      stderr: "ignore",
      stdin: "pipe",
      stdout: "ignore",
    });
    sidecar.unref();
    sidecar.stdin.unref();
    reaper = sidecar.stdin;
  }
  reaper.write(`${line}\n`);
  reaper.flush();
}

export function startProcess(
  command: string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
  }
): RunningCli {
  let stdout = "";
  let stderr = "";

  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  notifyReaper(`${proc.pid}`);
  proc.exited.then(() => notifyReaper(`-${proc.pid}`));

  const stdoutPromise = collectStream(proc.stdout, (chunk) => {
    stdout += chunk;
  });
  const stderrPromise = collectStream(proc.stderr, (chunk) => {
    stderr += chunk;
  });

  return {
    exitCode: (async () => {
      const code = await proc.exited;
      await Promise.all([stdoutPromise, stderrPromise]);
      return code;
    })(),
    getStderr: () => stderr,
    getStdout: () => stdout,
    kill: () => {
      proc.kill();
    },
    pid: proc.pid,
  };
}
