import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureServerBundleBytes } from "../../../../../scripts/measure-vercel-server-bundle.ts";

test("server bundle measurement counts the handler, application entry and split chunks only", () => {
  const dir = mkdtempSync(join(tmpdir(), "furin-vercel-bundle-"));
  try {
    writeFileSync(join(dir, "handler.js"), "handler");
    writeFileSync(join(dir, "chunk-abc.js"), "optional sync");
    writeFileSync(join(dir, "_furin-app.js"), "app");
    writeFileSync(join(dir, "index.js"), "bootstrap");
    writeFileSync(join(dir, "server-codec.js"), "codec");
    expect(measureServerBundleBytes(dir)).toBe(7 + 13 + 3);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
