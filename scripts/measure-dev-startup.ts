// biome-ignore-all lint/performance/noAwaitInLoops: each sample must run in its own process, without competing samples
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DevStartupReport, StartupAppReport, StartupSample } from "./compare-dev-startup.ts";

const STARTUP_TIMEOUT_MS = 30_000;
const SAMPLE_COUNT = 3;

interface StartupPage {
  contains: string;
  path: string;
}

interface StartupTarget {
  first: StartupPage;
  preload: string | undefined;
  second: StartupPage;
}

async function readPage(origin: string, page: StartupPage): Promise<void> {
  const response = await fetch(`${origin}${page.path}`, {
    signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
  });
  const html = await response.text();
  if (
    !(
      response.ok &&
      response.headers.get("content-type")?.includes("text/html") &&
      html.includes(page.contains)
    )
  ) {
    throw new Error(`${page.path} did not render the expected HTML (HTTP ${response.status})`);
  }
}

function reservePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
}

export async function measureAppStartup(
  projectDir: string,
  target: StartupTarget,
  extraEnv: { TASK_MANAGER_DB_PATH?: string }
): Promise<StartupSample> {
  const port = reservePort();
  const startedAt = performance.now();
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      ...(target.preload ? ["--preload", target.preload] : []),
      "--hot",
      "src/server.ts",
    ],
    cwd: projectDir,
    env: { ...process.env, ...extraEnv, NODE_ENV: "development", PORT: String(port) },
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let sample: StartupSample | undefined;
  let failure: unknown;

  try {
    let listenMs: number | undefined;
    while (performance.now() - startedAt < STARTUP_TIMEOUT_MS) {
      if (child.exitCode !== null) {
        throw new Error(`Server exited with code ${child.exitCode}`);
      }
      try {
        const socket = await Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: { data: () => undefined, error: () => undefined },
        });
        socket.end();
        listenMs = performance.now() - startedAt;
        break;
      } catch {
        await Bun.sleep(20);
      }
    }
    if (listenMs === undefined) {
      throw new Error(`Port did not open within ${STARTUP_TIMEOUT_MS} ms`);
    }
    const origin = `http://127.0.0.1:${port}`;
    await readPage(origin, target.first);
    const readyMs = performance.now() - startedAt;
    const secondStartedAt = performance.now();
    await readPage(origin, target.second);
    sample = { listenMs, readyMs, secondRouteMs: performance.now() - secondStartedAt };
  } catch (error) {
    failure = error;
  } finally {
    child.kill();
    await child.exited;
  }

  const [out, err] = await Promise.all([stdout, stderr]);
  if (failure !== undefined) {
    throw new Error(
      `Development startup failed in ${projectDir}: ${String(failure)}\n${out}\n${err}`
    );
  }
  if (sample === undefined) {
    throw new Error(`Development startup produced no sample in ${projectDir}`);
  }
  return sample;
}

function median(values: number[]): number {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) {
    throw new Error("No startup samples were collected");
  }
  return Math.round(middle);
}

async function measureApp(
  projectDir: string,
  target: StartupTarget,
  databaseDirectory: string | undefined
): Promise<StartupAppReport> {
  const samples: StartupSample[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const extraEnv = databaseDirectory
      ? { TASK_MANAGER_DB_PATH: join(databaseDirectory, `task-manager-${index}.sqlite`) }
      : {};
    const sample = await measureAppStartup(projectDir, target, extraEnv);
    samples.push(sample);
    console.log(
      `${projectDir}: port ${sample.listenMs.toFixed(0)} ms, first HTML ${sample.readyMs.toFixed(0)} ms, second route ${sample.secondRouteMs.toFixed(0)} ms`
    );
  }
  return {
    listenMs: median(samples.map((sample) => sample.listenMs)),
    readyMs: median(samples.map((sample) => sample.readyMs)),
    samples,
    secondRouteMs: median(samples.map((sample) => sample.secondRouteMs)),
  };
}

if (import.meta.main) {
  const [, , checkoutPath, reportPath] = Bun.argv;
  if (checkoutPath === undefined || reportPath === undefined) {
    throw new Error("Usage: bun scripts/measure-dev-startup.ts <project-checkout> <report.json>");
  }
  const checkout = resolve(checkoutPath);
  const tempDir = mkdtempSync(join(tmpdir(), "furin-startup-"));
  try {
    const apps: DevStartupReport["apps"] = {
      docs: await measureApp(
        join(checkout, "apps/docs"),
        {
          first: { contains: "<h1>Furin Documentation</h1>", path: "/docs" },
          preload: undefined,
          second: { contains: "<h1>File-Based Routing</h1>", path: "/docs/routing" },
        },
        undefined
      ),
      taskManager: await measureApp(
        join(checkout, "examples/task-manager"),
        {
          first: { contains: "Project Alpha", path: "/" },
          preload: undefined,
          second: { contains: "Task Manager RSC", path: "/rsc" },
        },
        tempDir
      ),
      weather: await measureApp(
        join(checkout, "examples/weather"),
        {
          first: { contains: "7-Day Forecast</h2>", path: "/" },
          preload: join(import.meta.dir, "startup-weather-preload.ts"),
          second: { contains: "7-Day Forecast</h2>", path: "/weather/london" },
        },
        undefined
      ),
    };
    const report: DevStartupReport = { apps, schemaVersion: 2 };
    await Bun.write(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}
