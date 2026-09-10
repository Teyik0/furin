import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  rewriteRelativeImports,
  rewriteSingletonImports,
  toImportSpecifier,
  transformDevSource,
  WORKSPACE_SOURCE_FILTER,
} from "../../../src/server/dev-page-plugin.ts";

describe("WORKSPACE_SOURCE_FILTER", () => {
  test.each([
    "/project/node_modules/react/jsx-runtime.js",
    "C:\\project\\node_modules\\react\\jsx-runtime.js",
    "/project/node_modules/.bun/react/index.js",
    "C:\\project\\node_modules\\.bun\\react\\index.js",
  ])("excludes dependency files on every platform: %s", (filePath) => {
    expect(WORKSPACE_SOURCE_FILTER.test(filePath)).toBe(false);
  });
});

test("development SSR selects the server isomorphic implementation", () => {
  const result = transformDevSource(
    `
      import { createIsomorphicFn } from "@teyik0/furin";
      import { serverValue } from "./server";
      import { clientValue } from "./client";

      export const getValue = createIsomorphicFn()
        .server(() => serverValue)
        .client(() => clientValue);
    `,
    "/app/src/shared.ts",
    { rewriteBareImports: false, rewriteRelativeImports: false }
  );

  expect(result).toContain("serverValue");
  expect(result).not.toContain("clientValue");
  expect(result).not.toContain("createIsomorphicFn");
});

test("development transform errors preserve their original stack", () => {
  try {
    transformDevSource(
      `
        import { createIsomorphicFn } from "@teyik0/furin";
        const builder = createIsomorphicFn();
        export const getValue = builder.server(() => "server-value");
      `,
      "/app/src/shared.ts",
      { rewriteBareImports: false, rewriteRelativeImports: false }
    );
    throw new Error("Expected the transform to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).stack).toContain("transform-isomorphic.ts");
    expect((error as Error).stack).not.toContain("rethrowWithSourcePath");
  }
});

describe("toImportSpecifier", () => {
  test("normalizes a native absolute path for cross-platform imports", () => {
    const specifier = toImportSpecifier("C:\\project\\src\\page.tsx");

    expect(specifier).toBe("C:/project/src/page.tsx");
    expect(specifier).not.toContain("\\");
    expect(toImportSpecifier("/project/src/page.tsx")).toBe("/project/src/page.tsx");
  });
});

describe("rewriteRelativeImports", () => {
  const dir = "/app/src/pages";

  test("rewrites named import from relative path", () => {
    const input = 'import { route } from "./root";';
    expect(rewriteRelativeImports(input, dir)).toBe(
      `import { route } from "${toImportSpecifier(resolve(dir, "root"))}";`
    );
  });

  test("rewrites default import from relative path", () => {
    const input = 'import Root from "./root";';
    const result = rewriteRelativeImports(input, dir);
    expect(result).toBe(`import Root from "${toImportSpecifier(resolve(dir, "root"))}";`);
  });

  test("rewrites parent-directory import (../)", () => {
    const input = 'import { route as rootRoute } from "../root";';
    const result = rewriteRelativeImports(input, "/app/src/pages/docs");
    expect(result).toContain(
      `from "${toImportSpecifier(resolve("/app/src/pages/docs", "../root"))}"`
    );
  });

  test("rewrites side-effect import", () => {
    const input = 'import "./styles.css";';
    const result = rewriteRelativeImports(input, dir);
    expect(result).toBe(`import "${toImportSpecifier(resolve(dir, "styles.css"))}";`);
  });

  test("rewrites re-export (export { x } from)", () => {
    const input = 'export { something } from "./utils";';
    const result = rewriteRelativeImports(input, dir);
    expect(result).toContain(`from "${toImportSpecifier(resolve(dir, "utils"))}"`);
  });

  test("rewrites namespace re-export (export * from)", () => {
    const input = 'export * from "./helpers";';
    const result = rewriteRelativeImports(input, dir);
    expect(result).toContain(`from "${toImportSpecifier(resolve(dir, "helpers"))}"`);
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

    expect(result).toContain(`from "${toImportSpecifier(resolve(dir, "root"))}"`);
    expect(result).toContain(`import "${toImportSpecifier(resolve(dir, "globals.css"))}"`);
    // Non-relative imports unchanged
    expect(result).toContain('from "@teyik0/furin/link"');
    expect(result).toContain('from "react"');
  });

  test("handles single-quoted imports", () => {
    const input = "import { foo } from './bar';";
    const result = rewriteRelativeImports(input, dir);
    expect(result).toContain(`from "${toImportSpecifier(resolve(dir, "bar"))}"`);
  });

  test("preserves deeply nested relative paths", () => {
    const input = 'import { x } from "../../components/button";';
    const result = rewriteRelativeImports(input, "/app/src/pages/docs");
    expect(result).toContain(
      `from "${toImportSpecifier(resolve("/app/src/pages/docs", "../../components/button"))}"`
    );
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

  test("output contains a normalized absolute path", () => {
    const input = 'import { useState } from "react";';
    const output = rewriteSingletonImports(input);
    expect(output).not.toContain("\\");
    expect(output).not.toContain('from "react"');
  });
});
