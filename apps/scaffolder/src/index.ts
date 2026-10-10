#!/usr/bin/env bun

import { cancel } from "@clack/prompts";
import { version } from "../package.json";
import { parseArgs } from "./args.ts";
import { run } from "./cli.ts";
import { ScaffolderError } from "./errors.ts";

if (typeof Bun === "undefined") {
  console.error("create-furin requires Bun. Install from https://bun.sh");
  process.exit(1);
}

try {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    console.log(version);
    process.exit(0);
  }

  await run(args);
} catch (error) {
  if (error instanceof ScaffolderError) {
    cancel(error.message);
    process.exit(1);
  }
  throw error;
}

function printHelp(): void {
  console.log(`
  create-furin

  Usage:
    bun create furin <dir>
    bun create furin <dir> --template full
    bunx @teyik0/create-furin <dir>

  Options:
    --template <simple|full>   Template to use (default: prompted)
    --yes                      Skip confirmation prompts
    --no-install               Skip bun install
    --help                     Show this help
    --version                  Show version
  `);
}
