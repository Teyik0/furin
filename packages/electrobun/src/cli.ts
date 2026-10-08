#!/usr/bin/env bun
// biome-ignore-all lint/performance/noAwaitInLoops: Restart supervision and readiness polling must be sequential.
import { statSync, watch } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { prepareDesktop } from "./prepare";
import { initDesktop, loadDesktopConfig, loadFurinProject } from "./project";
import { withShutdownDeadline } from "./runtime";

const FRONTEND_FILE = /\.(tsx|jsx|css)$/;

async function coreCli(root: string): Promise<string> {
  let directory: string | undefined = dirname(Bun.resolveSync("@teyik0/furin", root));
  while (directory) {
    const file = Bun.file(join(directory, "package.json"));
    if (await file.exists()) {
      const pkg: { name?: string; bin?: { furin?: string } } = await file.json();
      if (pkg.name === "@teyik0/furin" && pkg.bin?.furin) {
        return join(directory, pkg.bin.furin);
      }
    }
    const parent = dirname(directory);
    directory = directory === parent ? undefined : parent;
  }
  throw new Error("Cannot locate the Furin CLI; install @teyik0/furin.");
}

function sdkBootstrap(root: string): string {
  for (const from of [root, import.meta.dir]) {
    try {
      return join(dirname(Bun.resolveSync("electrobun/package.json", from)), "bin/electrobun.cjs");
    } catch {
      // The optional SDK can be resolved from either the consumer or this package.
    }
  }
  throw new Error("Install the optional desktop SDK with bun add -d electrobun@2.0.2.");
}

async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) {
    throw new Error(`Command failed (${status}): ${command.join(" ")}`);
  }
}

export async function desktopCommand(
  command: string,
  cwd: string,
  buildEnvironment?: "dev" | "stable"
): Promise<void> {
  if (command === "init") {
    await initDesktop(cwd);
    console.log("Desktop config and dev:desktop / build:desktop scripts added.");
    return;
  }
  if (command !== "dev" && command !== "build") {
    throw new Error("Usage: furin-electrobun init | dev | build");
  }
  const config = await loadDesktopConfig(cwd);
  if (command === "dev" && config.hostEntry) {
    throw new Error(
      "Custom hostEntry currently supports build only; use the application's web dev workflow."
    );
  }
  const project = await loadFurinProject(cwd);
  const sdk = sdkBootstrap(cwd);
  const env = { ...process.env, NODE_ENV: command === "build" ? "production" : "development" };
  const channel = command === "build" ? (buildEnvironment ?? "stable") : "dev";
  if (command === "build") {
    await run(
      [process.execPath, await coreCli(cwd), "build", "--target", "bun", "--output", "app"],
      cwd,
      env
    );
  }
  const generated = await prepareDesktop(cwd, config, { ...project, mode: command });
  await run([process.execPath, sdk, "prepare", `--env=${channel}`], generated, env);
  await run([process.execPath, sdk, "build", `--env=${channel}`], generated, env);
  if (command === "build") {
    console.log(`Desktop build: ${join(generated, "build")}`);
    return;
  }
  await runDesktopDev(project.root, project.serverEntry, config.dataDir, generated, sdk, env);
}

function stoppedByUser(child: Bun.Subprocess, stopping: boolean): boolean {
  return (
    stopping &&
    (child.signalCode === "SIGINT" ||
      child.signalCode === "SIGTERM" ||
      (process.platform === "win32" && (child.exitCode === 130 || child.exitCode === 143)))
  );
}

async function terminateOwnedWindow(window: Bun.Subprocess): Promise<void> {
  if (process.platform === "win32") {
    // Windows has no POSIX process groups. taskkill follows the live bootstrap's
    // descendants, not orphans whose bootstrap already exited. POSIX groups
    // likewise cannot own descendants that deliberately start a new session.
    if (window.exitCode === null && window.signalCode === null) {
      const killer = Bun.spawn(["taskkill", "/PID", String(window.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        const status = await withShutdownDeadline(killer.exited);
        if (status !== 0 && window.exitCode === null && window.signalCode === null) {
          throw new Error(`Desktop window tree termination failed (${status}).`);
        }
      } finally {
        if (killer.exitCode === null) {
          killer.kill("SIGKILL");
        }
        await killer.exited;
      }
    }
  } else {
    try {
      process.kill(-window.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
  await window.exited;
}

async function stopOwnedDevWorker(
  backend: Bun.Subprocess,
  control: string,
  isStopping: () => boolean
): Promise<void> {
  try {
    await writeFile(control, crypto.randomUUID());
    const status = await withShutdownDeadline(backend.exited);
    if (status !== 0 && !stoppedByUser(backend, isStopping())) {
      throw new Error(`Desktop dev backend shutdown failed (${status}).`);
    }
  } catch (error) {
    if (backend.exitCode === null) {
      backend.kill("SIGKILL");
      await backend.exited;
    }
    throw error;
  }
}

async function waitForDevReady(
  backend: Bun.Subprocess,
  ready: string,
  isStopping: () => boolean
): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (!(await Bun.file(ready).exists())) {
    if (isStopping()) {
      return false;
    }
    if (backend.exitCode !== null) {
      throw new Error(`Desktop dev backend exited (${backend.exitCode}) before listening.`);
    }
    if (Date.now() > deadline) {
      throw new Error("Desktop dev backend did not become ready.");
    }
    await Bun.sleep(50);
  }
  return !isStopping();
}

async function runDesktopDev(
  root: string,
  serverEntry: string,
  dataDir: string | undefined,
  generated: string,
  sdk: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  // No signal-based hot reload: managed SDK Bun does not implement SIGUSR.
  // A file command asks the running window to use the public close/quit APIs.
  let stopping = false;
  let restart = false;
  let backend: Bun.Subprocess | undefined;
  let listening = false;
  const { promise: stopped, resolve: signalStop } = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const control = join(generated, "control");
  const requestStop = async () => {
    await writeFile(control, crypto.randomUUID());
  };
  const resolvedData = dataDir ? resolve(dataDir) : undefined;
  const ownedData = resolvedData?.startsWith(`${root}${sep}`) ? resolvedData : undefined;
  // Backend imports can live anywhere in the project. Frontend HMR owns JSX/TSX/CSS;
  // hidden/generated directories and runtime-owned data must not restart the worker.
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) {
      return;
    }
    const path = join(root, filename);
    if (
      filename
        .split(sep)
        .some((part) => part.startsWith(".") || ["node_modules", "dist", "build"].includes(part)) ||
      (ownedData && (path === ownedData || path.startsWith(`${ownedData}${sep}`))) ||
      (path !== serverEntry && FRONTEND_FILE.test(filename)) ||
      statSync(path, { throwIfNoEntry: false })?.isDirectory()
    ) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      restart = true;
      requestStop().catch(console.error);
    }, 150);
  });
  const stop = () => {
    stopping = true;
    signalStop();
    requestStop().catch(console.error);
    // Before readiness the helper cannot read control yet. SIGTERM cancels
    // startup; ready workers continue to drain through the public control path.
    if (backend && !listening && backend.exitCode === null) {
      backend.kill("SIGTERM");
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    do {
      if (stopping) {
        return;
      }
      restart = false;
      listening = false;
      let canceledStartup = false;
      await writeFile(control, "");
      const ready = join(generated, "ready.json");
      await rm(ready, { force: true });
      if (stopping) {
        return;
      }
      backend = Bun.spawn([process.execPath, join(generated, "dev-server.ts")], {
        cwd: root,
        env,
        stdout: "inherit",
        stderr: "inherit",
      });
      try {
        if (!(await waitForDevReady(backend, ready, () => stopping || restart))) {
          if (backend.exitCode === null) {
            canceledStartup = true;
            backend.kill("SIGTERM");
          }
          continue;
        }
        listening = true;
        const window = Bun.spawn([process.execPath, sdk, "run", "--env=dev"], {
          cwd: generated,
          env,
          stdout: "inherit",
          stderr: "inherit",
          detached: process.platform !== "win32",
        });
        try {
          await Promise.race([window.exited, backend.exited, stopped]);
          await requestStop();
          const windowStatus = await withShutdownDeadline(window.exited);
          if (windowStatus !== 0 && !stoppedByUser(window, stopping)) {
            throw new Error(`Desktop window exited (${windowStatus}).`);
          }
        } finally {
          await terminateOwnedWindow(window);
        }
      } finally {
        await stopOwnedDevWorker(backend, control, () => stopping || canceledStartup);
        backend = undefined;
      }
    } while (restart && !stopping);
  } finally {
    watcher.close();
    clearTimeout(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (import.meta.main) {
  const [command, ...extra] = process.argv.slice(2);
  try {
    const [environment] = extra;
    if (
      !command ||
      extra.length > 1 ||
      (environment !== undefined &&
        (command !== "build" || !["--env=dev", "--env=stable"].includes(environment)))
    ) {
      throw new Error("Usage: furin-electrobun init | dev | build [--env=dev|stable]");
    }
    await desktopCommand(command, process.cwd(), environment === "--env=dev" ? "dev" : undefined);
  } catch (error) {
    console.error(`[furin-electrobun] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
