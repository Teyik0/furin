import { describe, expect, test } from "bun:test";
import { rewriteRelativeImports, rewriteSingletonImports } from "../src/dev-page-plugin.ts";

const ABSOLUTE_PATH_RE = /from "\/[^"]+"/;

describe("rewriteRelativeImports", () => {
  const dir = "/app/src/pages";

  test("rewrites named import from relative path", () => {
    const input = 'import { route } from "./root";';
    expect(rewriteRelativeImports(input, dir)).toBe('import { route } from "/app/src/pages/root";');
  });

  test("rewrites default import from relative path", () => {
    const input = 'import Root from "./root";';
    const result = rewriteRelativeImports(input, dir);
    expect(result).toBe('import Root from "/app/src/pages/root";');
  });

  test("rewrites parent-directory import (../)", () => {
    const input = 'import { route as rootRoute } from "../root";';
    const result = rewriteRelativeImports(input, "/app/src/pages/docs");
    expect(result).toContain('from "/app/src/pages/root"');
  });

  test("rewrites side-effect import", () => {
    const input = 'import "./styles.css";';
    const result = rewriteRelativeImports(input, dir);
    expect(result).toBe('import "/app/src/pages/styles.css";');
  });

  test("rewrites re-export (export { x } from)", () => {
    const input = 'export { something } from "./utils";';
    const result = rewriteRelativeImports(input, dir);
    expect(result).toContain('from "/app/src/pages/utils"');
  });

  test("rewrites namespace re-export (export * from)", () => {
    const input = 'export * from "./helpers";';
    const result = rewriteRelativeImports(input, dir);
    expect(result).toContain('from "/app/src/pages/helpers"');
  });

  test("does NOT rewrite bare module specifiers", () => {
    const input = 'import { useState } from "react";';
    expect(rewriteRelativeImports(input, dir)).toBe(input);
  });

  test("does NOT rewrite aliased paths (@/…)", () => {
    const input = 'import { client } from "@/client";';
    expect(rewriteRelativeImports(input, dir)).toBe(input);
  });

  test("handles multiple imports in one source", () => {
    const input = [
      'import { Link } from "@teyik0/furin/link";',
      'import { route } from "./root";',
      'import { useState } from "react";',
      'import "./globals.css";',
    ].join("\n");

    const result = rewriteRelativeImports(input, dir);

    expect(result).toContain('from "/app/src/pages/root"');
    expect(result).toContain('import "/app/src/pages/globals.css"');
    // Non-relative imports unchanged
    expect(result).toContain('from "@teyik0/furin/link"');
    expect(result).toContain('from "react"');
  });

  test("handles single-quoted imports", () => {
    const input = "import { foo } from './bar';";
    const result = rewriteRelativeImports(input, dir);
    expect(result).toContain('from "/app/src/pages/bar"');
  });

  test("preserves deeply nested relative paths", () => {
    const input = 'import { x } from "../../components/button";';
    const result = rewriteRelativeImports(input, "/app/src/pages/docs");
    expect(result).toContain('from "/app/src/components/button"');
  });
});

// ── rewriteSingletonImports ───────────────────────────────────────────────────

describe("rewriteSingletonImports", () => {
  // Helper: check that the output is different from the input (i.e. a rewrite
  // actually happened) and that the absolute path no longer contains the bare
  // specifier wrapped in quotes.
  function wasRewritten(input: string, pkg: string): boolean {
    const output = rewriteSingletonImports(input);
    return output !== input && !output.includes(`"${pkg}"`);
  }

  test("rewrites bare 'react' import", () => {
    expect(wasRewritten('import { useState } from "react";', "react")).toBe(true);
  });

  test("rewrites 'react/jsx-runtime' import", () => {
    expect(wasRewritten('import { jsx } from "react/jsx-runtime";', "react/jsx-runtime")).toBe(
      true
    );
  });

  test("rewrites 'react/jsx-dev-runtime' import", () => {
    expect(
      wasRewritten('import { jsxDEV } from "react/jsx-dev-runtime";', "react/jsx-dev-runtime")
    ).toBe(true);
  });

  test("rewrites 'react-dom' import", () => {
    expect(wasRewritten('import ReactDOM from "react-dom";', "react-dom")).toBe(true);
  });

  test("rewrites 'react-dom/client' import", () => {
    expect(wasRewritten('import { createRoot } from "react-dom/client";', "react-dom/client")).toBe(
      true
    );
  });

  test("rewrites 'react-dom/server' import", () => {
    expect(
      wasRewritten('import { renderToString } from "react-dom/server";', "react-dom/server")
    ).toBe(true);
  });

  test("rewrites single-quoted import", () => {
    expect(wasRewritten("import { useState } from 'react';", "react")).toBe(true);
  });

  test("rewrites type-only import", () => {
    expect(wasRewritten('import type { FC } from "react";', "react")).toBe(true);
  });

  test("rewrites re-export from react", () => {
    expect(wasRewritten('export { createContext } from "react";', "react")).toBe(true);
  });

  test("does NOT rewrite non-singleton packages", () => {
    const input = 'import { clsx } from "clsx";';
    expect(rewriteSingletonImports(input)).toBe(input);
  });

  test("does NOT rewrite react-adjacent packages like 'react-query'", () => {
    const input = 'import { useQuery } from "react-query";';
    expect(rewriteSingletonImports(input)).toBe(input);
  });

  test("does NOT rewrite relative imports", () => {
    const input = 'import { foo } from "./react";';
    expect(rewriteSingletonImports(input)).toBe(input);
  });

  test("rewrites multiple react imports in one source", () => {
    const input = [
      'import { useState, useEffect } from "react";',
      'import { jsx } from "react/jsx-runtime";',
      'import { clsx } from "clsx";',
    ].join("\n");
    const output = rewriteSingletonImports(input);
    expect(output).not.toContain('"react"');
    expect(output).not.toContain('"react/jsx-runtime"');
    // Non-singleton unchanged
    expect(output).toContain('"clsx"');
  });

  test("output contains an absolute path starting with '/'", () => {
    const input = 'import { useState } from "react";';
    const output = rewriteSingletonImports(input);
    // The rewritten specifier must be an absolute path
    expect(output).toMatch(ABSOLUTE_PATH_RE);
  });
});
