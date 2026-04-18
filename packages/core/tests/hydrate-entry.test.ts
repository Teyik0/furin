/**
 * Unit tests for generateHydrateEntry basePath behaviour.
 *
 * These are pure-function tests — no React, no DOM, no file I/O.
 * The function just returns a string, so assertions are simple
 * substring checks on the generated source code.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateHydrateEntry } from "../src/build/hydrate.ts";
import type { ResolvedRoute } from "../src/router.ts";

// ── Minimal stub ──────────────────────────────────────────────────────────────

function makeRoute(pattern: string, filePath: string): ResolvedRoute {
  return {
    pattern,
    path: filePath,
    mode: "ssg",
    page: {
      component: () => null,
      _route: { __type: "FURIN_ROUTE" },
    },
  } as unknown as ResolvedRoute;
}

const ROUTES = [makeRoute("/", "/app/src/pages/index.tsx")];
const ROOT = "/app/src/pages/root.tsx";

// ── B12: no basePath — generated code is unchanged ───────────────────────────

describe("generateHydrateEntry", () => {
  test("imports RouterProvider via package specifier so client links share one RouterContext", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    expect(code).toContain('import { RouterProvider } from "@teyik0/furin/link";');
    expect(code).not.toContain("/packages/core/src/link.tsx");
  });

  test("B12: without basePath — uses window.location.pathname directly", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    // No basePath stripping logic
    expect(code).toContain("window.location.pathname");
    expect(code).not.toContain("startsWith");
    expect(code).not.toContain(".slice(");
  });

  test("B12b: without basePath — log drain endpoint is the bare path", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    // endpoint should be the bare string, not a concatenation
    expect(code).toContain('endpoint: "/_furin/ingest"');
    // No string concatenation for the endpoint
    expect(code).not.toContain('" + "/_furin/ingest"');
  });

  test("B12c: without basePath — RouterProvider has no basePath prop", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "");
    expect(code).not.toContain("basePath:");
  });

  // ── B13: with basePath — stripping logic injected ────────────────────────────

  test("B13: with basePath='/furin' — code strips prefix before route matching", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "/furin");
    // The generated pathname expression uses a `b` variable for the basePath literal
    expect(code).toContain('const b = "/furin"');
    expect(code).toContain("startsWith(b)");
    expect(code).toContain("p.slice(b.length)");
  });

  test("B13b: with basePath — falls back to '/' when pathname equals basePath exactly", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "/furin");
    // e.g. "window.location.pathname.slice(...) || '/'"
    expect(code).toContain('|| "/"');
  });

  test("B13c: with basePath — log drain endpoint is prefixed", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "/furin");
    // endpoint should be basePath + "/_furin/ingest"
    expect(code).toContain('"/furin"');
    expect(code).toContain('"/_furin/ingest"');
  });

  // ── B14: basePath passed to RouterProvider ────────────────────────────────────

  test("B14: with basePath — RouterProvider receives basePath prop", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "/furin");
    expect(code).toContain('basePath: "/furin"');
  });

  test("B14b: different basePath value is correctly injected", () => {
    const code = generateHydrateEntry(ROUTES, ROOT, "/my-app");
    expect(code).toContain('basePath: "/my-app"');
    expect(code).toContain('const b = "/my-app"');
    expect(code).toContain("startsWith(b)");
  });

  test("client bundle keeps a single RouterContext when a page imports Link", () => {
    const tmpRoot = mkdtempSync(join(import.meta.dir, ".tmp-hydrate-entry-"));
    const outDir = join(tmpRoot, "out");
    mkdirSync(outDir, { recursive: true });

    try {
      const rootPath = join(tmpRoot, "root.tsx");
      const pagePath = join(tmpRoot, "index.tsx");
      const hydratePath = join(tmpRoot, "_hydrate.tsx");

      writeFileSync(
        rootPath,
        [
          'import { createRoute } from "@teyik0/furin/client";',
          "",
          "export const route = createRoute({",
          "  layout: ({ children }) => <div>{children}</div>,",
          "});",
        ].join("\n")
      );

      writeFileSync(
        pagePath,
        [
          'import { Link } from "@teyik0/furin/link";',
          "",
          "export default {",
          '  component: () => <Link to="/docs">Docs</Link>,',
          '  _route: { __type: "FURIN_ROUTE" },',
          "};",
        ].join("\n")
      );

      writeFileSync(hydratePath, generateHydrateEntry([makeRoute("/", pagePath)], rootPath, ""));

      const result = Bun.spawnSync(
        [
          "bun",
          "build",
          hydratePath,
          "--outdir",
          outDir,
          "--splitting",
          "--format",
          "esm",
          "--target",
          "browser",
        ],
        {
          cwd: join(import.meta.dir, "../.."),
          stderr: "pipe",
          stdout: "pipe",
        }
      );

      expect(result.exitCode).toBe(0);

      const bundleText = readdirSync(outDir)
        .filter((file) => file.endsWith(".js"))
        .map((file) => readFileSync(join(outDir, file), "utf8"))
        .join("\n");

      expect((bundleText.match(/createContext\(null\)/g) ?? []).length).toBe(1);
    } finally {
      rmSync(tmpRoot, { force: true, recursive: true });
    }
  });
});
