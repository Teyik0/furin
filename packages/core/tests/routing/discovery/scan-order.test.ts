import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";

const FURIN_ENTRY = join(import.meta.dir, "../../../src/furin.ts");

// root.tsx — minimal named route terminal with a layout.
const ROOT_MODULE = `
import { defineRootRoute } from ${JSON.stringify(FURIN_ENTRY)};
export const route = defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children);
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
import { defineRoute } from ${JSON.stringify(FURIN_ENTRY)};
import { route as rootRoute } from ${JSON.stringify(rel)};
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .page(() => null);
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
    tempDir = mkdtempSync(join(tmpdir(), "furin-scan-order-"));
    writeFileSync(join(tempDir, "root.tsx"), ROOT_MODULE);
  });

  afterEach(() => {
    rmSync(tempDir, { force: true, recursive: true });
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

  test("throws when two page files normalize to the same route pattern", async () => {
    writePage(join(tempDir, "foo.ts"));
    writePage(join(tempDir, "foo.tsx"));

    await expect(scanPages(tempDir)).rejects.toThrow(
      '[furin] Duplicate route pattern "/foo" from "foo.ts" and "foo.tsx".'
    );
  });

  test("throws when dynamic routes differ only by parameter name", async () => {
    mkdirSync(join(tempDir, "users"));
    writePage(join(tempDir, "users", "[id].tsx"));
    writePage(join(tempDir, "users", "[slug].tsx"));

    await expect(scanPages(tempDir)).rejects.toThrow(
      '[furin] Duplicate route pattern "/users/:param" from "users/[id].tsx" and "users/[slug].tsx".'
    );
  });

  test("allows a page file and same-name directory when their route patterns differ", async () => {
    mkdirSync(join(tempDir, "foo"));
    writePage(join(tempDir, "foo.tsx"));
    writePage(join(tempDir, "foo", "bar.tsx"));

    const { routes } = await scanPages(tempDir);

    expect(routes.map((route) => route.pattern)).toEqual(["/foo/bar", "/foo"]);
  });
});
