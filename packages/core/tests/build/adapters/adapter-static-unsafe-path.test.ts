import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildStaticTarget } from "../../../src/adapter/static.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { withBuildStub } from "../../support/with-build-stub.ts";

const UNSAFE_PATH_RE = /unsafe output path/;

test("buildStaticTarget rejects all unsafe output paths before writing the export", async () => {
  const app = createTmpApp("cli-app");
  const buildRoot = join(app.path, ".furin/build");
  const outDir = join(app.path, "dist");
  writeAppFile(
    app.path,
    "src/pages/[...slug].tsx",
    `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/[...slug]")
  .config({ mode: "ssg" })
  .staticParams(async () => [{ "*": "../../etc/passwd" }])
  .page(() => null);
`
  );

  try {
    const pagesDir = join(app.path, "src/pages");
    const { root, routes } = await scanPages(pagesDir);
    let thrown: unknown;
    try {
      await withBuildStub(() =>
        buildStaticTarget({ pagesDir, prefix: "", root, routes }, app.path, buildRoot, {
          staticConfig: { outDir },
          target: "static",
        })
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) {
      throw new TypeError("Expected static export to reject with an Error");
    }
    expect(thrown.message).toMatch(UNSAFE_PATH_RE);
    expect(existsSync(join(buildRoot, "static"))).toBe(false);
    expect(existsSync(outDir)).toBe(false);
  } finally {
    app.cleanup();
  }
}, 60_000);
