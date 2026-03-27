import { describe, expect, test } from "bun:test";
import { rewriteRelativeImports } from "../src/dev-page-plugin.ts";

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
