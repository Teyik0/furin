import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type RouteStyle, scanRouteManifest } from "../../../src/plugin/route-manifest.ts";

let pagesDir: string;

beforeEach(() => {
  pagesDir = mkdtempSync(join(tmpdir(), "furin-route-manifest-"));
});

afterEach(() => {
  rmSync(pagesDir, { force: true, recursive: true });
});

function touch(...files: string[]): void {
  for (const file of files) {
    const path = join(pagesDir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
}

function routesOf(style: RouteStyle, prefix = "") {
  return scanRouteManifest({ pagesDir, prefix, style }).routes.map((route) => ({
    id: route.id,
    kind: route.kind,
    parent: route.parentPath === undefined ? "root" : route.parentPath.slice(pagesDir.length + 1),
    pattern: route.pattern,
  }));
}

describe("tanstack style", () => {
  test("index and flat files become pages keyed like createFileRoute", () => {
    touch("__root.tsx", "index.tsx", "about.tsx");
    expect(routesOf("tanstack")).toEqual([
      { id: "/about", kind: "page", parent: "root", pattern: "/about" },
      { id: "/", kind: "page", parent: "root", pattern: "/" },
    ]);
  });

  test("route.tsx wraps its directory and an index is keyed with a trailing slash", () => {
    touch(
      "__root.tsx",
      "board/route.tsx",
      "board/$boardId/index.tsx",
      "board/$boardId/card/$cardId.tsx"
    );
    expect(routesOf("tanstack")).toEqual([
      {
        id: "/board/$boardId/card/$cardId",
        kind: "page",
        parent: "board/route.tsx",
        pattern: "/board/:boardId/card/:cardId",
      },
      {
        id: "/board/$boardId/",
        kind: "page",
        parent: "board/route.tsx",
        pattern: "/board/:boardId",
      },
      { id: "/board", kind: "layout", parent: "root", pattern: "/board" },
    ]);
  });

  test("a file next to a same-named directory is that directory's layout", () => {
    touch("__root.tsx", "settings.tsx", "settings/index.tsx", "settings/profile.tsx");
    expect(routesOf("tanstack")).toEqual([
      { id: "/settings/", kind: "page", parent: "settings.tsx", pattern: "/settings" },
      {
        id: "/settings/profile",
        kind: "page",
        parent: "settings.tsx",
        pattern: "/settings/profile",
      },
      { id: "/settings", kind: "layout", parent: "root", pattern: "/settings" },
    ]);
  });

  test("flat dot notation nests like directories", () => {
    touch("__root.tsx", "posts.tsx", "posts.index.tsx", "posts.$postId.edit.tsx");
    expect(routesOf("tanstack")).toEqual([
      {
        id: "/posts/$postId/edit",
        kind: "page",
        parent: "posts.tsx",
        pattern: "/posts/:postId/edit",
      },
      { id: "/posts/", kind: "page", parent: "posts.tsx", pattern: "/posts" },
      { id: "/posts", kind: "layout", parent: "root", pattern: "/posts" },
    ]);
  });

  test("a pathless layout wraps its children without adding a URL segment", () => {
    touch("__root.tsx", "_auth.tsx", "_auth/login.tsx");
    expect(routesOf("tanstack")).toEqual([
      { id: "/_auth/login", kind: "page", parent: "_auth.tsx", pattern: "/login" },
      { id: "/_auth", kind: "layout", parent: "root", pattern: "/" },
    ]);
  });

  test("a trailing underscore leaves the parent layout but keeps the URL segment", () => {
    touch("__root.tsx", "posts.tsx", "posts.index.tsx", "posts_.$postId.edit.tsx");
    expect(routesOf("tanstack")).toContainEqual({
      id: "/posts_/$postId/edit",
      kind: "page",
      parent: "root",
      pattern: "/posts/:postId/edit",
    });
  });

  test("optional params, splats, groups and escapes", () => {
    touch(
      "__root.tsx",
      "{-$lang}/about.tsx",
      "docs/$.tsx",
      "(marketing)/pricing.tsx",
      "script[.]js.tsx"
    );
    const manifest = scanRouteManifest({ pagesDir, prefix: "", style: "tanstack" });
    expect(manifest.routes.map(({ id, params, pattern }) => ({ id, params, pattern }))).toEqual([
      { id: "/(marketing)/pricing", params: [], pattern: "/pricing" },
      {
        id: "/{-$lang}/about",
        params: [{ name: "lang", optional: true }],
        pattern: "/:lang?/about",
      },
      { id: "/docs/$", params: [{ name: "_splat", optional: false }], pattern: "/docs/*" },
      { id: "/script[.]js", params: [], pattern: "/script.js" },
    ]);
  });

  test("dash-prefixed files and folders are private", () => {
    touch("__root.tsx", "index.tsx", "-components/button.tsx", "-helpers.ts");
    expect(routesOf("tanstack").map(({ id }) => id)).toEqual(["/"]);
  });

  test("ids start with the app prefix", () => {
    touch("__root.tsx", "index.tsx", "users.tsx");
    expect(routesOf("tanstack", "/admin").map(({ id }) => id)).toEqual(["/admin/", "/admin/users"]);
  });

  test("the root layout is __root.tsx and error files are ordinary routes", () => {
    touch("__root.tsx", "error.tsx");
    const manifest = scanRouteManifest({ pagesDir, prefix: "", style: "tanstack" });
    expect(manifest.rootPath).toBe(`${pagesDir}/__root.tsx`);
    expect(manifest.boundaries).toEqual([]);
    expect(manifest.routes.map(({ pattern }) => pattern)).toEqual(["/error"]);
  });

  test("rejects duplicate URL patterns", () => {
    touch("__root.tsx", "about.tsx", "(group)/about.tsx");
    expect(() => scanRouteManifest({ pagesDir, prefix: "", style: "tanstack" })).toThrow(
      'Duplicate route pattern "/about"'
    );
  });
});

describe("nextjs style", () => {
  test("page and layout files map to TanStack ids", () => {
    touch(
      "layout.tsx",
      "page.tsx",
      "board/layout.tsx",
      "board/[boardId]/page.tsx",
      "board/[boardId]/header.tsx"
    );
    const manifest = scanRouteManifest({ pagesDir, prefix: "", style: "nextjs" });
    expect(manifest.rootPath).toBe(`${pagesDir}/layout.tsx`);
    expect(routesOf("nextjs")).toEqual([
      {
        id: "/board/$boardId/",
        kind: "page",
        parent: "board/layout.tsx",
        pattern: "/board/:boardId",
      },
      { id: "/board", kind: "layout", parent: "root", pattern: "/board" },
      { id: "/", kind: "page", parent: "root", pattern: "/" },
    ]);
  });

  test("catch-all, optional catch-all, groups and private folders", () => {
    touch(
      "layout.tsx",
      "docs/[...slug]/page.tsx",
      "help/[[...path]]/page.tsx",
      "(marketing)/about/page.tsx",
      "_lib/page.tsx"
    );
    expect(routesOf("nextjs").map(({ id, pattern }) => ({ id, pattern }))).toEqual([
      { id: "/(marketing)/about/", pattern: "/about" },
      { id: "/docs/$", pattern: "/docs/*" },
      { id: "/help/$", pattern: "/help/*" },
    ]);
  });

  test("error and not-found files declare directory boundaries", () => {
    touch(
      "layout.tsx",
      "error.tsx",
      "page.tsx",
      "blog/not-found.tsx",
      "blog/error.tsx",
      "blog/page.tsx"
    );
    expect(scanRouteManifest({ pagesDir, prefix: "", style: "nextjs" }).boundaries).toEqual([
      { directory: pagesDir, errorPath: `${pagesDir}/error.tsx`, notFoundPath: undefined },
      {
        directory: `${pagesDir}/blog`,
        errorPath: `${pagesDir}/blog/error.tsx`,
        notFoundPath: `${pagesDir}/blog/not-found.tsx`,
      },
    ]);
  });

  test("route handlers are rejected", () => {
    touch("layout.tsx", "api/route.ts");
    expect(() => scanRouteManifest({ pagesDir, prefix: "", style: "nextjs" })).toThrow(
      "route handlers are not supported"
    );
  });
});

describe("review: collisions and catch-all layouts", () => {
  test("an optional segment that collides with a sibling route is rejected", () => {
    touch("__root.tsx", "index.tsx", "{-$lang}/index.tsx");
    expect(() => scanRouteManifest({ pagesDir, prefix: "", style: "tanstack" })).toThrow(
      "Duplicate route pattern"
    );
  });

  test("a Next.js layout inside a catch-all folder is rejected with a fix", () => {
    touch("layout.tsx", "docs/[...slug]/layout.tsx", "docs/[...slug]/page.tsx");
    expect(() => scanRouteManifest({ pagesDir, prefix: "", style: "nextjs" })).toThrow(
      "move it to the parent folder"
    );
  });
});
