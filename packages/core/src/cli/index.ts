#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildApp } from "../build/index.ts";
import { scanFurinInstances } from "../build/scan-server.ts";
import { BUILD_TARGETS, type BuildTarget } from "../config.ts";
import { normalizePrefix } from "../server/instance.ts";
import { loadCliConfig } from "./config.ts";
import { normalizeStaticPreviewBasePath, startStaticPreview } from "./preview.ts";

const argv = process.argv.slice(2);
const [command] = argv;

function log(msg: string): void {
  console.log(`\x1b[32m◆\x1b[0m ${msg}`);
}

function bail(msg: string): never {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
}

function parsePort(value: string | undefined): number {
  const candidate = value ?? process.env.PORT ?? "3000";
  const port = Number(candidate);
  if (!(Number.isInteger(port) && port > 0 && port <= 65_535)) {
    bail(`Invalid development port "${candidate}". Expected an integer between 1 and 65535.`);
  }
  return port;
}

function openBrowser(url: string): void {
  let browserCommand = ["xdg-open", url];
  if (process.platform === "darwin") {
    browserCommand = ["open", url];
  } else if (process.platform === "win32") {
    browserCommand = ["cmd.exe", "/c", "start", "", url];
  }
  try {
    Bun.spawn(browserCommand, {
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
    }).unref();
  } catch (error) {
    console.warn(`[furin] Could not open ${url}: ${String(error)}`);
  }
}

async function openWhenReady(
  url: string,
  child: Bun.Subprocess<"inherit", "inherit", "inherit">
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const controller = new AbortController();
    const remainingMs = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => controller.abort(), remainingMs);
    child.exited.then(() => controller.abort()).catch(() => controller.abort());
    try {
      // biome-ignore lint/performance/noAwaitInLoops: readiness probes must be sequential and bounded
      const response = await fetch(url, { signal: controller.signal });
      response.body?.cancel().catch(() => undefined);
      if (!response.ok) {
        throw new Error(`DevTools returned HTTP ${response.status}`);
      }
      openBrowser(url);
      return;
    } catch {
      if (child.exitCode !== null) {
        return;
      }
      await Bun.sleep(100);
    } finally {
      clearTimeout(timer);
    }
  }
  if (child.exitCode === null) {
    console.warn(`[furin] DevTools did not become reachable at ${url}`);
  }
}

function resolveCompileMode(
  flag: string | boolean | undefined,
  configCompile: "server" | "embed" | undefined
): "server" | "embed" | undefined {
  if (flag === "embed") {
    return "embed";
  }
  if (flag === true || flag === "server") {
    return "server";
  }
  if (flag !== undefined && flag !== false) {
    bail(`Invalid compile mode "${flag}". Valid: --compile server or --compile embed`);
  }
  return configCompile;
}

function extractCompileFlag(args: string[]): {
  compileFlag: string | boolean | undefined;
  parseableArgs: string[];
} {
  const parseableArgs: string[] = [];
  let compileFlag: string | boolean | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      parseableArgs.push(...args.slice(index));
      break;
    }
    if (arg === "--compile") {
      const next = args[index + 1];
      if (next && !next.startsWith("-")) {
        compileFlag = next;
        index += 1;
      } else {
        compileFlag = true;
      }
      continue;
    }
    if (arg?.startsWith("--compile=")) {
      compileFlag = arg.slice("--compile=".length);
      continue;
    }
    if (arg) {
      parseableArgs.push(arg);
    }
  }

  return { compileFlag, parseableArgs };
}

if (command === "dev") {
  let rawValues: ReturnType<typeof parseArgs>["values"];
  try {
    rawValues = parseArgs({
      args: argv.slice(1),
      options: {
        config: { type: "string" },
        "open-devtools": { type: "boolean" },
        port: { type: "string" },
      },
      strict: true,
    }).values;
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error));
  }
  const values = rawValues as {
    config?: string;
    "open-devtools"?: boolean;
    port?: string;
  };
  const config = await loadCliConfig(process.cwd(), values.config);
  const port = parsePort(values.port);
  const serverEntry = resolve(config.rootDir, config.serverEntry ?? "src/server.ts");
  if (!existsSync(serverEntry)) {
    bail(`[furin] Entrypoint ${config.serverEntry ?? "src/server.ts"} not found`);
  }
  const appUrl = `http://localhost:${port}/`;
  const configuredPrefixes =
    config.apps?.map((app) => normalizePrefix(app.prefix)) ??
    (config.pagesDir ? [""] : scanFurinInstances(serverEntry).map((instance) => instance.prefix));
  const prefixes = [...new Set(configuredPrefixes.length > 0 ? configuredPrefixes : [""])];
  const devtoolsUrls = prefixes.map((prefix) => new URL(`${prefix}/_furin/devtools`, appUrl).href);

  log("Development server starting");
  console.log(`  Local:     ${appUrl}`);
  for (const devtoolsUrl of devtoolsUrls) {
    console.log(`  DevTools:  ${devtoolsUrl}`);
  }
  console.log("  Press Ctrl+C to stop\n");

  const child = Bun.spawn([process.execPath, "--hot", serverEntry], {
    cwd: config.rootDir,
    env: { ...process.env, PORT: String(port) },
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  const openPromise = values["open-devtools"]
    ? openWhenReady(devtoolsUrls[0] as string, child)
    : Promise.resolve();
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    child.kill(signal);
  };
  const interrupt = (): void => stop("SIGINT");
  const terminate = (): void => stop("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const exitCode = await child.exited;
  await openPromise;
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  process.exitCode = exitCode;
} else if (command === "preview") {
  let rawValues: ReturnType<typeof parseArgs>["values"];
  try {
    rawValues = parseArgs({
      args: argv.slice(1),
      options: {
        basePath: { type: "string" },
        config: { type: "string" },
        dir: { type: "string" },
        port: { type: "string" },
      },
      strict: true,
    }).values;
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error));
  }

  const values = rawValues as {
    basePath?: string;
    config?: string;
    dir?: string;
    port?: string;
  };
  const config = await loadCliConfig(process.cwd(), values.config);
  const port = values.port === undefined ? 3000 : Number(values.port);
  if (!(Number.isInteger(port) && port > 0 && port <= 65_535)) {
    bail(`Invalid preview port "${values.port}". Expected an integer between 1 and 65535.`);
  }

  const distDir = resolve(config.rootDir, values.dir ?? config.static?.outDir ?? "dist");
  const basePath = normalizeStaticPreviewBasePath(values.basePath ?? config.static?.basePath ?? "");
  const server = startStaticPreview({ basePath, distDir, port });
  log("Static preview ready");
  console.log(`  Local:  ${new URL(`${basePath || ""}/`, server.url)}`);
  console.log(`  Serves: ${distDir}`);
  console.log("  Press Ctrl+C to stop\n");
} else if (command === "build") {
  const buildArgv = argv.slice(1);
  const { compileFlag, parseableArgs } = extractCompileFlag(buildArgv);
  let rawValues: ReturnType<typeof parseArgs>["values"];
  try {
    rawValues = parseArgs({
      args: parseableArgs,
      options: {
        analyze: { type: "boolean" },
        config: { type: "string" },
        pagesDir: { type: "string" },
        prefix: { type: "string" },
        target: { type: "string" },
      },
      strict: true,
    }).values;
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error));
  }

  const values = rawValues as {
    analyze?: boolean;
    target?: string;
    pagesDir?: string;
    prefix?: string;
    config?: string;
  };

  const target = values.target ?? "bun";

  if (target !== "all" && !(BUILD_TARGETS as readonly string[]).includes(target)) {
    bail(`Unsupported build target "${target}". Valid: ${BUILD_TARGETS.join(", ")}, all`);
  }

  const config = await loadCliConfig(process.cwd(), values.config);

  const isServerlessTarget = target === "static" || target === "package";

  const resolvedServerEntry = isServerlessTarget
    ? undefined
    : (() => {
        const entry = resolve(config.rootDir, config.serverEntry ?? "src/server.ts");
        if (!existsSync(entry)) {
          const expected = config.serverEntry ?? "src/server.ts";
          throw new Error(`[furin] Entrypoint ${expected} not found`);
        }
        return entry;
      })();

  log(`Building Furin for ${target}…`);

  const result = await buildApp({
    analyze: values.analyze,
    // --pagesDir/--prefix build a single explicit app; otherwise fall back to
    // the config's `apps` list (then to server.ts scanning inside buildApp).
    // normalizePrefix here so a bad --prefix fails before buildApp starts
    // (resolveAppSpecs normalizes config-provided prefixes the same way).
    apps:
      (values.pagesDir ?? config.pagesDir)
        ? [
            {
              pagesDir: values.pagesDir ?? (config.pagesDir as string),
              prefix: normalizePrefix(values.prefix),
            },
          ]
        : config.apps,
    clientLogging: config.clientLogging ?? false,
    compile: resolveCompileMode(compileFlag, config.bun?.compile),
    optimizeImports: config.optimizeImports,
    pagesDir: undefined,
    plugins: config.plugins,
    reactCompiler: config.reactCompiler,
    rootDir: config.rootDir,
    serverEntry: resolvedServerEntry,
    staticConfig: config.static,
    target: target as BuildTarget | "all",
  });

  const built = Object.keys(result.targets).join(", ") || "none";
  log(`Done: ${built} → .furin/build`);
} else if (!command || command === "help") {
  console.log(
    `Furin CLI

USAGE
  furin dev [options]
  furin build [options]
  furin preview [options]

DEV OPTIONS
  --config          Config file path
  --port            Listening port (default: PORT or 3000)
  --open-devtools   Open the Furin DevTools dashboard when the server is ready

BUILD OPTIONS
  --target    ${BUILD_TARGETS.join(" | ")} | all  (default: bun)
              "package" builds a publishable Elysia-plugin artifact (register.js + factory + client assets)
  --pagesDir  Pages directory
  --prefix    Mount prefix for the built app (e.g. /admin) — pairs with --pagesDir
  --config    Config file path
  --compile   server | embed  Compile to binary: "server" keeps client on disk, "embed" is self-contained
  --analyze   Write complete client bundle metafiles to .furin/build/analysis

PREVIEW OPTIONS
  --dir       Static export directory (default: static.outDir or dist)
  --basePath  Static export base path (default: static.basePath or "")
  --port      Listening port (default: 3000)
  --config    Config file path
`
  );
} else {
  bail(`Unknown command "${command}". Run "furin help" for usage.`);
}
