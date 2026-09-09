#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildApp } from "../build/index.ts";
import { BUILD_TARGETS, type BuildTarget } from "../config.ts";
import { normalizePrefix } from "../server/instance.ts";
import { loadCliConfig } from "./config.ts";
import { startStaticPreview } from "./preview.ts";

const argv = process.argv.slice(2);
const [command] = argv;

function log(msg: string): void {
  console.log(`\x1b[32m◆\x1b[0m ${msg}`);
}

function bail(msg: string): never {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
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

if (command === "preview") {
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
  const basePath = values.basePath ?? config.static?.basePath ?? "";
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
        target: { type: "string" },
        pagesDir: { type: "string" },
        prefix: { type: "string" },
        config: { type: "string" },
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
    target: target as BuildTarget | "all",
    compile: resolveCompileMode(compileFlag, config.bun?.compile),
    rootDir: config.rootDir,
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
    pagesDir: undefined,
    serverEntry: resolvedServerEntry,
    plugins: config.plugins,
    staticConfig: config.static,
    clientLogging: config.clientLogging ?? false,
    reactCompiler: config.reactCompiler,
  });

  const built = Object.keys(result.targets).join(", ") || "none";
  log(`Done: ${built} → .furin/build`);
} else if (!command || command === "help") {
  console.log(
    `Furin CLI

USAGE
  furin build [options]
  furin preview [options]

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
