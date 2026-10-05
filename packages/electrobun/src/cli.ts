#!/usr/bin/env bun
// biome-ignore-all lint/performance/noAwaitInLoops: Restart supervision and readiness polling must be sequential.
import { watch } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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

export async function desktopCommand(command: string, cwd: string): Promise<void> {
  if (command === "init") {
    await initDesktop(cwd);
    console.log("Desktop config and dev:desktop / build:desktop scripts added.");
    return;
  }
  if (command !== "dev" && command !== "build") {
    throw new Error("Usage: furin-electrobun init | dev | build");
  }
  const config = await loadDesktopConfig(cwd);
  const project = await loadFurinProject(cwd);
  const sdk = sdkBootstrap(cwd);
  const env = { ...process.env, NODE_ENV: command === "build" ? "production" : "development" };
  if (command === "build") {
    await run(
      [process.execPath, await coreCli(cwd), "build", "--target", "bun", "--output", "app"],
      cwd,
      env
    );
  }
  const generated = await prepareDesktop(cwd, config, { ...project, mode: command });
  await run(
    [process.execPath, sdk, "prepare", `--env=${command === "build" ? "stable" : "dev"}`],
    generated,
    env
  );
  await run(
    [process.execPath, sdk, "build", `--env=${command === "build" ? "stable" : "dev"}`],
    generated,
    env
  );
  if (command === "build") {
    console.log(`Desktop build: ${join(generated, "build")}`);
    return;
  }
  await runDesktopDev(project.root, project.serverEntry, generated, sdk, env);
}

async function stopOwnedDevWorker(backend: Bun.Subprocess, control: string): Promise<void> {
  try {
    await writeFile(control, crypto.randomUUID());
    const status = await withShutdownDeadline(backend.exited);
    if (status !== 0) {
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

async function runDesktopDev(
  root: string,
  serverEntry: string,
  generated: string,
  sdk: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  // No signal-based hot reload: managed SDK Bun does not implement SIGUSR.
  // A file command asks the running window to use the public close/quit APIs.
  let stopping = false;
  let restart = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const control = join(generated, "control");
  const requestStop = async () => {
    await writeFile(control, crypto.randomUUID());
  };
  const watcher = watch(dirname(serverEntry), { recursive: true }, (_event, filename) => {
    if (
      !filename ||
      filename.startsWith(".") ||
      filename.includes("node_modules") ||
      (filename !== basename(serverEntry) && FRONTEND_FILE.test(filename))
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
    requestStop().catch(console.error);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    do {
      restart = false;
      await writeFile(control, "");
      const ready = join(generated, "ready.json");
      await rm(ready, { force: true });
      const backend = Bun.spawn([process.execPath, join(generated, "dev-server.ts")], {
        cwd: root,
        env,
        stdout: "inherit",
        stderr: "inherit",
      });
      try {
        const deadline = Date.now() + 30_000;
        while (!(await Bun.file(ready).exists())) {
          if (backend.exitCode !== null) {
            throw new Error(`Desktop dev backend exited (${backend.exitCode}) before listening.`);
          }
          if (Date.now() > deadline || stopping) {
            throw new Error("Desktop dev backend did not become ready.");
          }
          await Bun.sleep(50);
        }
        const window = Bun.spawn([process.execPath, sdk, "run", "--env=dev"], {
          cwd: generated,
          env,
          stdout: "inherit",
          stderr: "inherit",
        });
        await Promise.race([window.exited, backend.exited]);
        await requestStop();
        const windowStatus = await window.exited;
        if (windowStatus !== 0) {
          throw new Error(`Desktop window exited (${windowStatus}).`);
        }
      } finally {
        await stopOwnedDevWorker(backend, control);
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
    if (!command || extra.length) {
      throw new Error("Usage: furin-electrobun init | dev | build");
    }
    await desktopCommand(command, process.cwd());
  } catch (error) {
    console.error(`[furin-electrobun] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
