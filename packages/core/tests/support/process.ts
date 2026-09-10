// biome-ignore-all lint/performance/noAwaitInLoops: process output stream must be read sequentially
import { resolve } from "node:path";
import { withBuildTestLock } from "./build-lock.ts";

const CLI_ENTRY = resolve(import.meta.dir, "../../src/cli/index.ts");

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
    const exitCode = await Promise.race([
      proc.exitCode,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          proc.kill();
          reject(new Error(`CLI command timed out: ${args.join(" ")}`));
        }, 30_000);
      }),
    ]);

    return {
      exitCode,
      stderr: proc.getStderr(),
      stdout: proc.getStdout(),
    };
  });
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
