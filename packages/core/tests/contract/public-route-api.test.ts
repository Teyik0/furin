import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface PackageManifest {
  exports: { [subpath: string]: unknown };
}

describe("public route API", () => {
  test("exposes defineRoute as the only route authoring contract", () => {
    const packageRoot = join(import.meta.dir, "../..");
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8")
    ) as PackageManifest;
    const mainEntry = readFileSync(join(packageRoot, "src/furin.ts"), "utf8");

    expect(manifest.exports["./router"]).toBeUndefined();
    expect(mainEntry).not.toContain("export type { ResolvedRoute");
    expect(mainEntry).not.toContain("export type { SegmentBoundary");
  });
});
