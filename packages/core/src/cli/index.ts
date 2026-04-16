#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildApp } from "../build/index.ts";
import { BUILD_TARGETS, type BuildTarget } from "../config.ts";
import { loadCliConfig } from "./config.ts";

const argv = process.argv.slice(2);
const command = argv[0];

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

if (command === "build") {
  const { values: rawValues } = parseArgs({
    args: argv.slice(1),
    options: {
      target: { type: "string" },
      pagesDir: { type: "string" },
      config: { type: "string" },
    },
    strict: false,
  });

  const values = rawValues as {
    target?: string;
    pagesDir?: string;
    config?: string;
  };

  // --compile has an optional value: absent → undefined, present alone → true, present with "embed" → "embed"
  const buildArgv = argv.slice(1);
  const compileIdx = buildArgv.indexOf("--compile");
  let compileFlag: string | boolean | undefined;
  if (compileIdx < 0) {
    compileFlag = undefined;
  } else {
    const next = buildArgv[compileIdx + 1];
    compileFlag = next && !next.startsWith("-") ? next : true;
  }

  const target = values.target ?? "bun";

  if (target !== "all" && !(BUILD_TARGETS as readonly string[]).includes(target)) {
    bail(`Unsupported build target "${target}". Valid: ${BUILD_TARGETS.join(", ")}, all`);
  }

  const config = await loadCliConfig(process.cwd(), values.config);

  const isStaticTarget = target === "static";

  const resolvedServerEntry = isStaticTarget
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
    target: target as BuildTarget | "all",
    compile: resolveCompileMode(compileFlag, config.bun?.compile),
    rootDir: config.rootDir,
    pagesDir: values.pagesDir ?? config.pagesDir,
    serverEntry: resolvedServerEntry,
    plugins: config.plugins,
    staticConfig: config.static,
  });

  const built = Object.keys(result.targets).join(", ") || "none";
  log(`Done: ${built} → .furin/build`);
} else if (!command || command === "help") {
  console.log(
    `Furin CLI

USAGE  furin build [options]

OPTIONS
  --target    ${BUILD_TARGETS.join(" | ")} | all  (default: bun)
  --pagesDir  Pages directory
  --config    Config file path
  --compile   server | embed  Compile to binary: "server" keeps client on disk, "embed" is self-contained
`
  );
} else {
  bail(`Unknown command "${command}". Run "furin help" for usage.`);
}
