import { parseArgs } from "node:util";
import { buildApp } from "../build";
import { BUILD_TARGETS, type BuildTarget } from "../config";
import { loadCliConfig, resolveServerEntrypoint } from "./config";

const argv = process.argv.slice(2);
const command = argv[0];

function log(msg: string): void {
  console.log(`\x1b[32m◆\x1b[0m ${msg}`);
}

function bail(msg: string): never {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
}

if (command === "build") {
  const { values: rawValues } = parseArgs({
    args: argv.slice(1),
    options: {
      target: { type: "string" },
      outDir: { type: "string" },
      pagesDir: { type: "string" },
      config: { type: "string" },
      compile: { type: "boolean" },
    },
    strict: false,
  });

  const values = rawValues as {
    target?: string;
    outDir?: string;
    pagesDir?: string;
    config?: string;
    compile?: boolean;
  };

  const target = values.target ?? "bun";

  if (target !== "all" && !(BUILD_TARGETS as readonly string[]).includes(target)) {
    bail(`Unsupported build target "${target}". Valid: ${BUILD_TARGETS.join(", ")}, all`);
  }

  const config = await loadCliConfig(process.cwd(), values.config);
  const serverEntry = resolveServerEntrypoint(
    config.rootDir,
    target === "all" ? undefined : (target as BuildTarget)
  );

  log(`Building Elyra for ${target}…`);

  const result = await buildApp({
    target: target as BuildTarget | "all",
    compile: values.compile ?? config.bun?.compile,
    rootDir: config.rootDir,
    pagesDir: values.pagesDir ?? config.pagesDir,
    outDir: values.outDir ?? config.outDir,
    minify: config.client?.minify,
    sourcemap: config.client?.sourcemap,
    serverEntry: config.serverEntry ?? serverEntry ?? undefined,
  });

  const built = Object.keys(result.targets).join(", ") || "none";
  log(`Done: ${built} → ${values.outDir ?? config.outDir ?? ".elyra/build"}`);
} else if (!command || command === "help") {
  console.log(
    `Elyra CLI

USAGE  elyra build [options]

OPTIONS
  --target    ${BUILD_TARGETS.join(" | ")} | all  (default: bun)
  --outDir    Output directory                     (default: .elyra/build)
  --pagesDir  Pages directory
  --config    Config file path
  --compile   Compile to binary (bun only)
`
  );
} else {
  bail(`Unknown command "${command}". Run "elyra help" for usage.`);
}
