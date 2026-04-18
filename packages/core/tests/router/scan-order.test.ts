import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { scanPages } from "../../src/router.ts";
import { __setDevMode, IS_DEV } from "../../src/runtime-env.ts";

// root.tsx — minimal FURIN_ROUTE with a layout, no external imports
const ROOT_MODULE = `
const route = { __type: "FURIN_ROUTE", layout: ({ children }) => children };
export { route };
`;

// page module that inherits from root — import path is computed per page so
// nested files (subdirs) still resolve to the same root module instance,
// guaranteeing object identity for validateRouteChain.
function pageModule(pageAbsPath: string, rootAbsPath: string): string {
  let rel = relative(dirname(pageAbsPath), rootAbsPath).replaceAll("\\", "/");
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return `
import { route as rootRoute } from ${JSON.stringify(rel)};
export default {
  __type: "FURIN_PAGE",
  _route: { __type: "FURIN_ROUTE", parent: rootRoute },
  component: () => null,
};
`;
}

let originalDevMode: boolean;
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalDevMode));

describe("scanPages: route order is deterministic", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `furin-scan-order-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "root.tsx"), ROOT_MODULE);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writePage(absPath: string) {
    writeFileSync(absPath, pageModule(absPath, join(tempDir, "root.tsx")));
  }

  test("flat pages are returned in alphabetical pattern order", async () => {
    // Write pages in reverse-alphabetical order to surface non-sorted readdir
    writePage(join(tempDir, "zzz.tsx"));
    writePage(join(tempDir, "aaa.tsx"));
    writePage(join(tempDir, "mmm.tsx"));

    const { routes } = await scanPages(tempDir);
    const patterns = routes.map((r) => r.pattern);

    expect(patterns).toEqual(["/aaa", "/mmm", "/zzz"]);
  });

  test("nested pages are returned in alphabetical pattern order", async () => {
    // Create subdirectories — readdir may return them in any order
    mkdirSync(join(tempDir, "zebra"));
    writePage(join(tempDir, "zebra", "index.tsx"));
    mkdirSync(join(tempDir, "alpha"));
    writePage(join(tempDir, "alpha", "index.tsx"));
    writePage(join(tempDir, "mango.tsx"));

    const { routes } = await scanPages(tempDir);
    const patterns = routes.map((r) => r.pattern);

    expect(patterns).toEqual(["/alpha", "/mango", "/zebra"]);
  });

  test("mixed static and dynamic segments sort deterministically", async () => {
    mkdirSync(join(tempDir, "blog"));
    writePage(join(tempDir, "blog", "[slug].tsx"));
    writePage(join(tempDir, "blog", "about.tsx"));
    writePage(join(tempDir, "index.tsx"));

    const { routes } = await scanPages(tempDir);
    const patterns = routes.map((r) => r.pattern);

    // Sorted alphabetically by the collected file paths, not by pattern semantics:
    //   blog/[slug].tsx  ('[' = 0x5B)  →  /blog/:slug
    //   blog/about.tsx   ('a' = 0x61)  →  /blog/about
    //   index.tsx                       →  /
    // (subdir 'blog/' sorts before 'index.tsx' because 'b' < 'i')
    expect(patterns).toEqual(["/blog/:slug", "/blog/about", "/"]);
  });
});
