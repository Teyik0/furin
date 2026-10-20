import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildRouteTree, collectRouteFiles, fileRouteId } from "../../../src/plugin/route-tree.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";

const FURIN_ENTRY = join(import.meta.dir, "../../../src/furin.ts");

// root.tsx — minimal named route terminal with a layout.
const ROOT_MODULE = `
import { defineRootRoute } from ${JSON.stringify(FURIN_ENTRY)};
export const route = defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children);
`;

// page module keyed by its place under the root's directory.
function pageModule(pageAbsPath: string, rootAbsPath: string): string {
  return `
import { defineRoute } from ${JSON.stringify(FURIN_ENTRY)};
export const route = defineRoute(${JSON.stringify(fileRouteId({ pagesDir: dirname(rootAbsPath), prefix: "" }, pageAbsPath))})
  .config({ mode: "ssr" })
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

  test("ignores private directories and declaration files when discovering public pages", async () => {
    mkdirSync(join(tempDir, "_private"));
    writeFileSync(
      join(tempDir, "_private", "component.tsx"),
      'throw new Error("private module must not execute");'
    );
    writeFileSync(join(tempDir, "global.d.ts"), "declare const clientName: string;");
    writePage(join(tempDir, "index.tsx"));
    const { routes } = await scanPages(tempDir);
    expect(routes.map((route) => route.pattern)).toEqual(["/"]);
  });

  test("flat pages are returned in alphabetical pattern order", async () => {
    // Write pages in reverse-alphabetical order to surface non-sorted readdir
    writePage(join(tempDir, "zzz.tsx"));
    writePage(join(tempDir, "aaa.tsx"));
    writePage(join(tempDir, "mmm.tsx"));

    const { routes } = await scanPages(tempDir);
    const patterns = routes.map((r) => r.pattern);

    expect(patterns).toEqual(["/aaa", "/mmm", "/zzz"]);
  });

  test("route groups organize pages without adding URL segments", async () => {
    mkdirSync(join(tempDir, "(marketing)", "(public)"), { recursive: true });
    writePage(join(tempDir, "(marketing)", "(public)", "index.tsx"));
    writePage(join(tempDir, "(marketing)", "about.tsx"));

    const { routes } = await scanPages(tempDir);

    expect(routes.map((route) => route.pattern).toSorted()).toEqual(["/", "/about"]);
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

  test("rejects pages in different groups that resolve to the same URL", async () => {
    mkdirSync(join(tempDir, "(admin)"));
    mkdirSync(join(tempDir, "(marketing)"));
    writePage(join(tempDir, "(admin)", "about.tsx"));
    writePage(join(tempDir, "(marketing)", "about.tsx"));

    await expect(scanPages(tempDir)).rejects.toThrow(
      '[furin] Duplicate route pattern "/about" from "(admin)/about.tsx" and "(marketing)/about.tsx".'
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

describe("scanPages and the route tree share one file manifest", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "furin-scan-manifest-"));
    writeFileSync(join(tempDir, "root.tsx"), ROOT_MODULE);
  });

  afterEach(() => {
    rmSync(tempDir, { force: true, recursive: true });
  });

  function routeTreePatterns(): string[] {
    return collectRouteFiles(buildRouteTree(tempDir, "test"))
      .filter((file) => file.path !== "")
      .map((file) => file.path)
      .toSorted();
  }

  for (const devMode of [false, true]) {
    test(`a symlinked page file is a route for both (${devMode ? "dev" : "build"})`, async () => {
      mkdirSync(join(tempDir, "_shared"));
      const target = join(tempDir, "_shared", "about.tsx");
      writeFileSync(target, pageModule(target, join(tempDir, "root.tsx")));
      symlinkSync(target, join(tempDir, "about.tsx"));
      writeFileSync(
        join(tempDir, "index.tsx"),
        pageModule(join(tempDir, "index.tsx"), join(tempDir, "root.tsx"))
      );

      __setDevMode(devMode);
      try {
        const { routes } = await scanPages(tempDir);
        expect(routes.map((route) => route.pattern).toSorted()).toEqual(routeTreePatterns());
      } finally {
        __setDevMode(false);
      }
    });
  }

  test("an invalid dynamic segment above a convention file is rejected by both", async () => {
    mkdirSync(join(tempDir, "[bad-name]"));
    writeFileSync(join(tempDir, "[bad-name]", "error.tsx"), "export default () => null;");

    expect(() => buildRouteTree(tempDir, "test")).toThrow("Invalid dynamic parameter");
    await expect(scanPages(tempDir)).rejects.toThrow("Invalid dynamic parameter");
  });
});
