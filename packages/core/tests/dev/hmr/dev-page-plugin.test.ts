import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  loadDevPageContents,
  registerDevPagePlugin,
  rewriteRelativeImports,
  rewriteSingletonImports,
  toImportSpecifier,
  transformDevSource,
  WORKSPACE_SOURCE_FILTER,
} from "../../../src/server/dev-page-plugin.ts";
import { createTmpApp } from "../../support/app-fixtures.ts";

const MDX_FILTER = /\.mdx$/;

test.each(["mjs", "cjs", "mts", "cts"])(
  "virtual development reloads an edited .%s helper",
  async (extension) => {
    const directory = mkdtempSync(resolve(tmpdir(), "furin-dev-extension-"));
    const page = resolve(directory, "page.ts");
    const helper = resolve(directory, `helper.${extension}`);
    const annotation = extension.endsWith("ts") ? ": string" : "";
    try {
      writeFileSync(page, `export { value } from "./helper.${extension}";`);
      writeFileSync(helper, `export const value${annotation} = "original";`);
      registerDevPagePlugin();
      expect((await import(`${page}?furin-server&t=1`)).value).toBe("original");
      writeFileSync(helper, `export const value${annotation} = "updated";`);
      expect((await import(`${page}?furin-server&t=2`)).value).toBe("updated");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
);

test("a virtual page can load its deferred render module", async () => {
  const app = createTmpApp("cli-app");
  const directory = app.path;
  const filePath = resolve(directory, "page.tsx");
  try {
    writeFileSync(resolve(directory, "label.ts"), 'export const label = "Deferred page";');
    writeFileSync(
      filePath,
      `import { defineRoute } from "@teyik0/furin";
      import { label } from "./label";
      export const route = defineRoute().config({ mode: "ssr" }).page(() => <p>{label}</p>);`
    );
    registerDevPagePlugin();
    const { route } = await import(`${filePath}?furin-server&t=1`);
    const loadRender = Reflect.get(route.component, Symbol.for("furin.dev.render"));
    expect(loadRender).toBeFunction();
    const { default: render } = await loadRender();
    expect(render().props.children).toBe("Deferred page");
  } finally {
    app.cleanup();
  }
});

test("a virtual development loader resolves a dynamically imported MDX alias", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "furin-dev-mdx-"));
  const filePath = resolve(directory, "page.ts");
  const markdown = "# Sync & Invalidations\n";
  try {
    writeFileSync(
      resolve(directory, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } })
    );
    writeFileSync(resolve(directory, "sync.mdx"), markdown);
    writeFileSync(
      filePath,
      'export async function loadSync() { return (await import("@/sync.mdx")).default; }'
    );
    Bun.plugin({
      name: "dev-loader-test-mdx",
      setup(build) {
        build.onLoad({ filter: MDX_FILTER }, async (args) => ({
          contents: `export default ${JSON.stringify(await Bun.file(args.path).text())};`,
          loader: "js",
        }));
      },
    });
    registerDevPagePlugin();
    const imported = (await import(`${filePath}?furin-server&t=1`)) as {
      loadSync: () => Promise<string>;
    };
    expect(await imported.loadSync()).toBe(markdown);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("virtual modules refresh aliased imports and re-exports while preserving import examples", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "furin-dev-alias-"));
  const filePath = resolve(directory, "page.ts");
  const example = 'import "@/value.ts"';
  try {
    writeFileSync(
      resolve(directory, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } })
    );
    writeFileSync(resolve(directory, "value.ts"), 'export const value = "loaded";');
    writeFileSync(
      filePath,
      [
        `export const example = '${example}';`,
        '// import "@/value.ts"',
        'export const prefix = "😀";',
        'import { value } from "@/value.ts";',
        'export { value } from "@/value.ts";',
        'export const label = "café " + value;',
        'export async function loadValue() { return (await import("@/value.ts")).value; }',
      ].join("\n")
    );
    registerDevPagePlugin();
    const imported = (await import(`${filePath}?furin-server&t=1`)) as {
      example: string;
      label: string;
      loadValue: () => Promise<string>;
      value: string;
    };

    expect(imported.example).toBe(example);
    expect(imported.value).toBe("loaded");
    expect(imported.label).toBe("café loaded");
    expect(await imported.loadValue()).toBe("loaded");

    writeFileSync(resolve(directory, "value.ts"), 'export const value = "updated";');
    const refreshed = await import(`${filePath}?furin-server&t=2`);
    expect(refreshed.value).toBe("updated");
    expect(refreshed.label).toBe("café updated");
    expect(await refreshed.loadValue()).toBe("updated");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test.each([
  {
    name: "development loader keeps text import attributes",
    source:
      'import migrationSql from "./migration.sql" with { type: "text" }; export const sql = migrationSql;',
  },
  {
    name: "a type-only import cannot consume a text import from the same file",
    source:
      'import { type Ignored } from "./migration.sql"; import migrationSql from "./migration.sql" with { type: "text" }; export const sql = migrationSql;',
  },
])("$name", async ({ source }) => {
  const directory = mkdtempSync(resolve(tmpdir(), "furin-dev-import-"));
  const filePath = resolve(directory, "migration.ts");
  try {
    writeFileSync(resolve(directory, "migration.sql"), "SELECT 1;");
    writeFileSync(filePath, source);
    registerDevPagePlugin();
    const imported = (await import(filePath)) as { sql: string };
    expect(imported.sql).toBe("SELECT 1;");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a deleted page finishes an in-flight load from its last transformed source", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "furin-dev-page-"));
  const filePath = resolve(directory, "page.tsx");
  const cache = new Map<string, { contents: string; moduleIdentity: string }>();
  const loadedIdentity = `${filePath}?t=1`;

  try {
    writeFileSync(filePath, 'export const marker = "loaded";');
    const loaded = await loadDevPageContents(filePath, loadedIdentity, cache);
    writeFileSync(filePath, 'export const marker = "edited";');
    const editedIdentity = `${filePath}?t=2`;
    const edited = await loadDevPageContents(filePath, editedIdentity, cache);

    expect(edited).not.toBe(loaded);
    expect(cache.size).toBe(1);
    rmSync(filePath);

    expect(await loadDevPageContents(filePath, editedIdentity, cache)).toBe(edited);
    expect(cache.size).toBe(0);
    expect(await loadDevPageContents(filePath, `${filePath}?t=3`, cache)).toContain(
      "route = undefined"
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

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
  test("keeps import-like text inside strings, templates, and comments intact", () => {
    const input = `export const example = "import React from 'react';";
      export const template = \`export { useState } from "react";\`;
      // import React from "react";
      /* import "react/jsx-runtime"; */`;
    expect(rewriteSingletonImports(input)).toBe(input);
  });
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
