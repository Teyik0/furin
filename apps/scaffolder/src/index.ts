#!/usr/bin/env bun

import { run } from "./cli.ts";

const exitCode = await run(process.argv.slice(2));

if (exitCode !== 0) {
  process.exit(exitCode);
}
