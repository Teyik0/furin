import "../../setup/global.ts";

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";

const { buildStaticTarget } = await import("../../../src/adapter/static.ts");
const UNSAFE_PATH_RE = /unsafe output path/;

test("buildStaticTarget rejects all unsafe output paths before creating artifacts", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "furin-static-unsafe-"));
  const buildRoot = join(rootDir, ".furin/build");
  const outDir = join(rootDir, "dist");
  const routeEntry = { __type: "FURIN_ROUTE" } satisfies RootLayout["route"];
  const root: RootLayout = { path: join(rootDir, "root.tsx"), route: routeEntry };
  const unsafeRoute: ResolvedRoute = {
    mode: "ssg",
    page: {
      __type: "FURIN_PAGE",
      _route: routeEntry,
      component: () => null,
      staticParams: async () => [{ "*": "../../etc/passwd" }],
    },
    path: join(rootDir, "[...slug].tsx"),
    pattern: "/*",
    routeChain: [routeEntry],
    segmentBoundaries: [],
  };

  try {
    let thrown: unknown;
    try {
      await buildStaticTarget([unsafeRoute], rootDir, buildRoot, root, {
        staticConfig: { outDir },
        target: "static",
      });
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
    rmSync(rootDir, { force: true, recursive: true });
  }
});
