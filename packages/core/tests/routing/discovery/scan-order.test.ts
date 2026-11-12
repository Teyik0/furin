import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteInstanceSpec } from "../../../src/plugin/route-manifest.ts";
import { buildRouteTree, collectRouteFiles } from "../../../src/plugin/route-tree.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";

const FURIN_ENTRY = join(import.meta.dir, "../../../src/furin.ts");

// __root.tsx — minimal named route terminal with a layout.
const ROOT_MODULE = `
import { defineRootRoute } from ${JSON.stringify(FURIN_ENTRY)};
export const route = defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children);
`;

// The id is type-only at runtime: any string keeps the module valid.
const PAGE_MODULE = `
import { defineRoute } from ${JSON.stringify(FURIN_ENTRY)};
export const route = defineRoute("/page")
  .config({ mode: "ssr" })
  .page(() => null);
`;

const LAYOUT_MODULE = `
import { defineRoute } from ${JSON.stringify(FURIN_ENTRY)};
export const route = defineRoute("/layout")
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`;

function tanstack(pagesDir: string): RouteInstanceSpec {
  return { pagesDir, prefix: "", style: "tanstack" };
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
    writeFileSync(join(tempDir, "__root.tsx"), ROOT_MODULE);
  });

  afterEach(() => {
    rmSync(tempDir, { force: true, recursive: true });
  });

  function writePage(absPath: string) {
    writeFileSync(absPath, PAGE_MODULE);
  }

  test("ignores private directories and declaration files when discovering public pages", async () => {
    mkdirSync(join(tempDir, "-private"));
    writeFileSync(
      join(tempDir, "-private", "component.tsx"),
      'throw new Error("private module must not execute");'
    );
    writeFileSync(join(tempDir, "global.d.ts"), "declare const clientName: string;");
    writePage(join(tempDir, "index.tsx"));
    const { routes } = await scanPages(tanstack(tempDir));
    expect(routes.map((route) => route.pattern)).toEqual(["/"]);
  });

  test("flat pages are returned in alphabetical pattern order", async () => {
    // Write pages in reverse-alphabetical order to surface non-sorted readdir
    writePage(join(tempDir, "zzz.tsx"));
    writePage(join(tempDir, "aaa.tsx"));
    writePage(join(tempDir, "mmm.tsx"));

    const { routes } = await scanPages(tanstack(tempDir));
    const patterns = routes.map((r) => r.pattern);

    expect(patterns).toEqual(["/aaa", "/mmm", "/zzz"]);
  });

  test("route groups organize pages without adding URL segments", async () => {
    mkdirSync(join(tempDir, "(marketing)", "(public)"), { recursive: true });
    writePage(join(tempDir, "(marketing)", "(public)", "index.tsx"));
    writePage(join(tempDir, "(marketing)", "about.tsx"));

    const { routes } = await scanPages(tanstack(tempDir));

    expect(routes.map((route) => route.pattern).toSorted()).toEqual(["/", "/about"]);
  });

  test("nested pages are returned in alphabetical pattern order", async () => {
    // Create subdirectories — readdir may return them in any order
    mkdirSync(join(tempDir, "zebra"));
    writePage(join(tempDir, "zebra", "index.tsx"));
    mkdirSync(join(tempDir, "alpha"));
    writePage(join(tempDir, "alpha", "index.tsx"));
    writePage(join(tempDir, "mango.tsx"));

    const { routes } = await scanPages(tanstack(tempDir));
    const patterns = routes.map((r) => r.pattern);

    expect(patterns).toEqual(["/alpha", "/mango", "/zebra"]);
  });

  test("mixed static and dynamic segments sort deterministically", async () => {
    mkdirSync(join(tempDir, "blog"));
    writePage(join(tempDir, "blog", "$slug.tsx"));
    writePage(join(tempDir, "blog", "about.tsx"));
    writePage(join(tempDir, "index.tsx"));

    const { routes } = await scanPages(tanstack(tempDir));
    const patterns = routes.map((r) => r.pattern);

    // Sorted by the collected file paths, not by pattern semantics:
    //   blog/$slug.tsx   ('$' sorts first)  →  /blog/:slug
    //   blog/about.tsx                       →  /blog/about
    //   index.tsx                       →  /
    // (subdir 'blog/' sorts before 'index.tsx' because 'b' < 'i')
    expect(patterns).toEqual(["/blog/:slug", "/blog/about", "/"]);
  });

  test("throws when two page files normalize to the same route id", async () => {
    writePage(join(tempDir, "foo.ts"));
    writePage(join(tempDir, "foo.tsx"));

    await expect(scanPages(tanstack(tempDir))).rejects.toThrow(
      '[furin] Duplicate route id "/foo" from "foo.ts" and "foo.tsx".'
    );
  });

  test("throws when dynamic routes differ only by parameter name", async () => {
    mkdirSync(join(tempDir, "users"));
    writePage(join(tempDir, "users", "$id.tsx"));
    writePage(join(tempDir, "users", "$slug.tsx"));

    await expect(scanPages(tanstack(tempDir))).rejects.toThrow(
      '[furin] Duplicate route pattern "/users/:param" from "users/$id.tsx" and "users/$slug.tsx".'
    );
  });

  test("rejects pages in different groups that resolve to the same URL", async () => {
    mkdirSync(join(tempDir, "(admin)"));
    mkdirSync(join(tempDir, "(marketing)"));
    writePage(join(tempDir, "(admin)", "about.tsx"));
    writePage(join(tempDir, "(marketing)", "about.tsx"));

    await expect(scanPages(tanstack(tempDir))).rejects.toThrow(
      '[furin] Duplicate route pattern "/about" from "(admin)/about.tsx" and "(marketing)/about.tsx".'
    );
  });

  test("a file next to a same-name directory is the layout of its pages", async () => {
    mkdirSync(join(tempDir, "foo"));
    writeFileSync(join(tempDir, "foo.tsx"), LAYOUT_MODULE);
    writePage(join(tempDir, "foo", "bar.tsx"));

    const { routes } = await scanPages(tanstack(tempDir));

    expect(routes.map((route) => route.pattern)).toEqual(["/foo/bar"]);
    expect(routes[0]?.layouts).toEqual([
      { path: join(tempDir, "foo.tsx").replaceAll("\\", "/"), pattern: "/foo" },
    ]);
  });
});

describe("scanPages and the route tree share one file manifest", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "furin-scan-manifest-"));
    writeFileSync(join(tempDir, "__root.tsx"), ROOT_MODULE);
  });

  afterEach(() => {
    rmSync(tempDir, { force: true, recursive: true });
  });

  function routeTreePatterns(): string[] {
    return collectRouteFiles(buildRouteTree(tanstack(tempDir), "test"))
      .filter((file) => file.path !== "")
      .map((file) => file.path)
      .toSorted();
  }

  for (const devMode of [false, true]) {
    test(`a symlinked page file is a route for both (${devMode ? "dev" : "build"})`, async () => {
      mkdirSync(join(tempDir, "-shared"));
      const target = join(tempDir, "-shared", "about.tsx");
      writeFileSync(target, PAGE_MODULE);
      symlinkSync(target, join(tempDir, "about.tsx"));
      writeFileSync(join(tempDir, "index.tsx"), PAGE_MODULE);

      __setDevMode(devMode);
      try {
        const { routes } = await scanPages(tanstack(tempDir));
        expect(routes.map((route) => route.pattern).toSorted()).toEqual(routeTreePatterns());
      } finally {
        __setDevMode(false);
      }
    });
  }

  test("an invalid dynamic segment is rejected by both", async () => {
    mkdirSync(join(tempDir, "$bad-name"));
    writeFileSync(join(tempDir, "$bad-name", "error.tsx"), "export default () => null;");

    expect(() => buildRouteTree(tanstack(tempDir), "test")).toThrow("Invalid dynamic parameter");
    await expect(scanPages(tanstack(tempDir))).rejects.toThrow("Invalid dynamic parameter");
  });
});
