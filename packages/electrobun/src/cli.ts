#!/usr/bin/env bun
import { realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, sep, win32 } from "node:path";
import type { DesktopConfig } from "./config";
import { prepareDesktop } from "./prepare";
import { initDesktop, loadDesktopConfig, loadFurinProject } from "./project";
import { prepareSdkResolution } from "./sdk-resolution";
import { defaultDesktopDataDir, resolveDesktopDataDir } from "./storage";

const MODULE_PATH = /.*/;
const WINDOWS_BASE = /^[a-z]:[\\/]|^\\\\/i;
const WINDOWS_DRIVE_INPUT = /^(?:\.\.[\\/])*[\\/]?([a-z]:[\\/].*)$/i;

export function backendInputPath(base: string, path: string): string {
  const api = WINDOWS_BASE.test(base) ? win32 : posix;
  // Bun can prefix cross-drive metafile inputs with a relative/root separator.
  return api.resolve(base, api === win32 ? path.replace(WINDOWS_DRIVE_INPUT, "$1") : path);
}

export async function backendDependencies(
  root: string,
  entries: string[],
  sdkAliases: { [specifier: string]: string },
  nativeAliases: { [specifier: string]: string }
): Promise<Set<string> | undefined> {
  const files = new Set(entries);
  // Each build gets fresh resolution state; Bun.resolveSync caches renamed
  // extensionless targets for the supervisor's entire process lifetime.
  // No outdir: the JavaScript API returns in-memory artifacts without writing files.
  const result = await Bun.build({
    entrypoints: entries,
    root,
    target: "bun",
    packages: "external",
    metafile: true,
    throw: false,
    plugins: [
      {
        name: "desktop-backend-ownership",
        setup(builder) {
          builder.onResolve({ filter: MODULE_PATH }, (args) => {
            const sdkPath = sdkAliases[args.path];
            if (sdkPath) {
              return { path: sdkPath, external: true };
            }
            const target = nativeAliases[args.path];
            if (target) {
              const canonicalSdk = sdkAliases[target];
              if (canonicalSdk) {
                return { path: canonicalSdk, external: true };
              }
              if (isAbsolute(target) || target.startsWith(".")) {
                return { path: resolve(root, target) };
              }
              return { path: target, external: true };
            }
            if (isAbsolute(args.path) && !resolve(args.path).startsWith(`${root}${sep}`)) {
              return { path: args.path, external: true };
            }
          });
        },
      },
    ],
  });
  if (!result.success) {
    for (const diagnostic of result.logs) {
      console.error(diagnostic);
    }
    console.error("[furin-electrobun] Backend compilation failed; waiting for source changes.");
    return;
  }
  if (result.metafile === undefined) {
    throw new Error("Desktop dependency scan did not produce the requested metafile.");
  }
  // Observe Bun's resolved inputs, including file assets, without an onLoad
  // hook: passing file-loader imports through that hook can panic Bun.
  // Bun reports them relative to the canonical working directory, not `root`.
  const base = await realpath(process.cwd());
  await Promise.all(
    Object.keys(result.metafile.inputs).map(async (path) => {
      files.add(await realpath(backendInputPath(base, path)));
    })
  );
  return files;
}

async function coreCli(root: string): Promise<string> {
  let directory: string | undefined = dirname(Bun.resolveSync("@teyik0/furin", root));
  while (directory) {
    const file = Bun.file(join(directory, "package.json"));
    // biome-ignore lint/performance/noAwaitInLoops: Walk up package directories sequentially.
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

/** Shared by the hot backend and the native shell for one development session. */
export interface DesktopDevelopmentSettings {
  config: DesktopConfig & { app: DesktopConfig["app"] & { version: string } };
  dataDir: string;
  generated: string;
  nativeAliases: { [specifier: string]: string };
  /** Relative to root. */
  nativeEntry: string | undefined;
  openBrowser: boolean;
  root: string;
  sdk: string;
  sdkAliases: { [specifier: string]: string };
}

function developmentDataDir(identifier: string): string {
  const home = homedir();
  const xdg = process.env.XDG_DATA_HOME;
  let root = xdg && isAbsolute(xdg) ? xdg : join(home, ".local/share");
  if (process.platform === "darwin") {
    root = join(home, "Library/Application Support");
  } else if (process.platform === "win32") {
    root = process.env.LOCALAPPDATA ?? join(home, "AppData/Local");
  }
  return defaultDesktopDataDir(root, identifier, "dev");
}

/** Prepares the SDK and returns the environment of Furin's hot development worker. */
export async function prepareDesktopDevelopment(
  cwd: string,
  openBrowser: boolean
): Promise<{ [name: string]: string }> {
  const config = await loadDesktopConfig(cwd);
  const project = await loadFurinProject(cwd);
  const sdk = sdkBootstrap(cwd);
  const env = { ...process.env, NODE_ENV: "development" };
  const generated = await prepareDesktop(cwd, config, { ...project, mode: "dev" });
  await run([process.execPath, sdk, "prepare", "--env=dev"], generated, env);
  const settings: DesktopDevelopmentSettings = {
    config,
    dataDir:
      config.dataDir === undefined
        ? developmentDataDir(config.app.identifier)
        : await resolveDesktopDataDir(config.dataDir, {
            channel: "dev",
            env,
            mode: "dev",
            root: project.root,
          }),
    generated,
    nativeEntry: config.build?.bun?.entrypoint,
    nativeAliases: Object.fromEntries(
      Object.entries(config.build?.bun?.alias ?? {}).map(([name, target]) => [
        name,
        target.startsWith(".") ? resolve(project.root, target) : target,
      ])
    ),
    openBrowser,
    root: project.root,
    sdk,
    sdkAliases: await prepareSdkResolution(generated),
  };
  const path = join(generated, "dev.json");
  await writeFile(path, JSON.stringify(settings), { mode: 0o600 });
  return { FURIN_DESKTOP_DEV: path, NODE_ENV: "development" };
}

/** One development orchestrator: Furin's hot worker owns the backend and the native shell. */
export async function runDesktopDevelopment(cwd: string, openBrowser: boolean): Promise<void> {
  const child = Bun.spawn(
    [process.execPath, await coreCli(cwd), "dev", ...(openBrowser ? [] : ["--desktop"])],
    { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }
  );
  // The core CLI drains its worker; repeated signals from the terminal group are idempotent.
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    const code = await child.exited;
    if (code !== 0) {
      throw new Error(`Desktop development exited (${code}).`);
    }
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

export async function desktopCommand(
  command: string,
  cwd: string,
  buildEnvironment?: "dev" | "stable"
): Promise<void> {
  if (command === "init") {
    await initDesktop(cwd);
    console.log("Desktop scripts configured through furin.config.ts.");
    return;
  }
  if (command === "dev") {
    await runDesktopDevelopment(cwd, false);
    return;
  }
  if (command !== "build" && command !== "prepare") {
    throw new Error("Usage: furin-electrobun init | prepare | dev | build");
  }
  const config = await loadDesktopConfig(cwd);
  const project = await loadFurinProject(cwd);
  const sdk = sdkBootstrap(cwd);
  const env = {
    ...process.env,
    NODE_ENV: command === "build" ? "production" : "development",
  };
  const channel = command === "build" ? (buildEnvironment ?? "stable") : "dev";
  if (command === "build") {
    await run(
      [
        process.execPath,
        await coreCli(cwd),
        "build",
        "--target",
        "bun",
        "--output",
        "app",
        ...(config.external ?? []).flatMap((name) => ["--external", name]),
      ],
      cwd,
      env
    );
  }
  const generated = await prepareDesktop(cwd, config, {
    ...project,
    mode: command === "build" ? "build" : "dev",
  });
  await run([process.execPath, sdk, "prepare", `--env=${channel}`], generated, env);
  await prepareSdkResolution(generated);
  if (command === "prepare") {
    return;
  }
  await run([process.execPath, sdk, "build", `--env=${channel}`], generated, env);
  console.log(`Desktop build: ${join(generated, "build")}`);
}

if (import.meta.main) {
  const [command, ...extra] = process.argv.slice(2);
  try {
    const environment = extra.at(0);
    if (
      !command ||
      extra.length > 1 ||
      (environment !== undefined &&
        (command !== "build" || !["--env=dev", "--env=stable"].includes(environment)))
    ) {
      throw new Error("Usage: furin-electrobun init | prepare | dev | build [--env=dev|stable]");
    }
    await desktopCommand(command, process.cwd(), environment === "--env=dev" ? "dev" : undefined);
  } catch (error) {
    console.error(`[furin-electrobun] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
