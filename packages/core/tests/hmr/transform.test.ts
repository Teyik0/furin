import { describe, expect, test } from "bun:test";
import { transformForReactRefresh } from "../../src/hmr/transform";

// ---------------------------------------------------------------------------
// Shared fake paths
// All tests use a consistent fake directory tree so relative-import rewriting
// is deterministic without touching the real filesystem.
// ---------------------------------------------------------------------------
const SRC_DIR = "/fake/project/src";
const PAGES_DIR = "/fake/project/src/pages";
const INDEX_FILE = "/fake/project/src/pages/index.tsx";
const INDEX_MODULE_ID = "/_modules/src/pages/index.tsx";

// ---------------------------------------------------------------------------
// Top-level regex constants (satisfies lint/performance/useTopLevelRegex)
// ---------------------------------------------------------------------------
const REACT_IMPORT_RE = /from\s+["']react["']/;
const ELYSION_CLIENT_IMPORT_RE = /from\s+["']elysion\/client["']/;
const ELYSIA_IMPORT_RE = /from\s+["']elysia["']/;
const HMR_RUNTIME_COMMENT_RE = /^\/\/ HMR Runtime Setup for/;
const REFRESH_REG_RE = /\$RefreshReg\$\s*\(\s*\w*ElysionPage/;

/**
 * Run the full transform pipeline with sensible defaults.
 * Individual tests override only what they need.
 */
function transform(
  code: string,
  {
    file = INDEX_FILE,
    moduleId = INDEX_MODULE_ID,
    srcDir = SRC_DIR,
    pagesDir = PAGES_DIR,
  }: {
    file?: string;
    moduleId?: string;
    srcDir?: string;
    pagesDir?: string;
  } = {}
): string {
  return transformForReactRefresh(code, file, moduleId, srcDir, pagesDir);
}

// ---------------------------------------------------------------------------
// Server import stripping
// These imports must NEVER reach the browser bundle.
// ---------------------------------------------------------------------------
describe("server import stripping", () => {
  test("strips default React import", () => {
    const result = transform(`import React from "react";\nexport const x = 1;`);
    expect(result).not.toMatch(REACT_IMPORT_RE);
  });

  test("strips named React import { useState, useEffect }", () => {
    const result = transform(`import { useState, useEffect } from "react";\nexport const x = 1;`);
    expect(result).not.toMatch(REACT_IMPORT_RE);
  });

  test("strips namespace import * as React from 'react'", () => {
    const result = transform(`import * as React from "react";\nexport const x = 1;`);
    expect(result).not.toMatch(REACT_IMPORT_RE);
  });

  test("strips elysion/client import", () => {
    const result = transform(`import { createRoute } from "elysion/client";\nexport const x = 1;`);
    expect(result).not.toMatch(ELYSION_CLIENT_IMPORT_RE);
  });

  test("strips elysia import", () => {
    const result = transform(`import { t } from "elysia";\nexport const x = 1;`);
    expect(result).not.toMatch(ELYSIA_IMPORT_RE);
  });

  test("strips CSS import", () => {
    const result = transform(`import "./styles.css";\nexport const x = 1;`);
    expect(result).not.toContain(".css");
  });
});

// ---------------------------------------------------------------------------
// HMR wrapper
// The wrapper is what lets React Refresh operate per-module.
// Changes to its shape break client-side HMR silently.
// ---------------------------------------------------------------------------
describe("HMR wrapper", () => {
  test("defines a scoped $RefreshReg$ variable", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("var $RefreshReg$");
  });

  test("defines a scoped $RefreshSig$ variable", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("var $RefreshSig$");
  });

  test("embeds the module ID as a fallback", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain(INDEX_MODULE_ID);
  });

  test("reads stable module ID from window.__CURRENT_MODULE__", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("window.__CURRENT_MODULE__");
  });

  test("saves prevRefreshReg before module runs", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("const prevRefreshReg = window.$RefreshReg$");
  });

  test("restores prevRefreshReg after module runs", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("window.$RefreshReg$ = prevRefreshReg");
  });

  test("saves prevRefreshSig before module runs", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("const prevRefreshSig = window.$RefreshSig$");
  });

  test("restores prevRefreshSig after module runs", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("window.$RefreshSig$ = prevRefreshSig");
  });

  test("module ID changes propagate into the wrapper", () => {
    const customId = "/_modules/src/pages/blog/post.tsx";
    const result = transform("export const x = 1;", { moduleId: customId });
    expect(result).toContain(customId);
    expect(result).not.toContain(INDEX_MODULE_ID);
  });
});

// ---------------------------------------------------------------------------
// Globals injection
// Browser modules rely on these globals being present because server-only
// imports (react, elysion/client, elysia) are stripped.
// ---------------------------------------------------------------------------
describe("globals injection", () => {
  test("injects const React = window.React", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("const React = window.React");
  });

  test("destructures React hooks from window.React", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("window.React");
    // A representative sample — the full list matters too, but testing each
    // hook name individually would couple tests to the exact hook list.
    for (const hook of [
      "useState",
      "useEffect",
      "useCallback",
      "useRef",
      "useContext",
      "useReducer",
    ]) {
      expect(result).toContain(hook);
    }
  });

  test("injects createRoute from window.__ELYSION__", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("window.__ELYSION__");
    expect(result).toContain("createRoute");
  });

  test("injects elysia t Proxy stub", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("const t = new Proxy");
  });
});

// ---------------------------------------------------------------------------
// JSX / TypeScript transformation
// ---------------------------------------------------------------------------
describe("JSX and TypeScript transformation", () => {
  test("transforms JSX into React.createElement calls", () => {
    const result = transform("export const App = () => <div>hello</div>;");
    expect(result).not.toContain("<div>");
    expect(result).toContain("createElement");
  });

  test("strips TypeScript interface declarations", () => {
    const result = transform(`
      interface Props { name: string; age: number; }
      export const App = (props: Props) => null;
    `);
    expect(result).not.toContain("interface Props");
    expect(result).not.toContain(": Props");
  });

  test("strips TypeScript type annotations on function parameters", () => {
    const result = transform("export const greet = (name: string): string => name;");
    expect(result).not.toContain(": string");
  });

  test("preserves runtime logic after stripping types", () => {
    const result = transform(`
      export const double = (n: number): number => n * 2;
    `);
    expect(result).toContain("n * 2");
  });
});

// ---------------------------------------------------------------------------
// page() component extraction
// The custom Babel plugin lifts inline arrow functions into named declarations
// so React Refresh can register them properly.
// ---------------------------------------------------------------------------
describe("page() component extraction", () => {
  test("extracts inline arrow component into a named _ElysionPage function", () => {
    const code = "export default page({ component: (props) => null });";
    const result = transform(code);
    expect(result).toContain("ElysionPage");
  });

  test("registers the extracted component with React Refresh", () => {
    // Use a realistic component that returns JSX and uses a hook so React
    // Refresh's babel plugin recognises _ElysionPage and emits _s()/
    // $RefreshReg$ calls, which the post-processing step then picks up.
    const code = `
      export default page({
        component: (props) => {
          const [v] = useState(0);
          return /*#__PURE__*/React.createElement("div", null, v);
        }
      });
    `;
    const result = transform(code);
    // Extraction happened — the generated name is present in the output
    expect(result).toContain("ElysionPage");
    // The extracted function must be followed by a $RefreshReg$ call
    expect(result).toMatch(REFRESH_REG_RE);
  });

  test("does not throw when component is already a named reference", () => {
    const code = `
      function HomePage() { return null; }
      export default page({ component: HomePage });
    `;
    // Component is an identifier — extraction is skipped, no error
    expect(() => transform(code)).not.toThrow();
  });

  test("does not throw when page() has no component property", () => {
    expect(() => transform("export default page({ head: () => ({}) });")).not.toThrow();
  });

  test("does not throw when export default is not a page() call", () => {
    expect(() => transform("export default function NotAPage() { return null; }")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// import.meta.hot stripping
// Hot-reload guards written for Vite/other bundlers must be erased so they
// do not run in the browser (import.meta.hot is undefined at runtime).
// ---------------------------------------------------------------------------
describe("import.meta.hot stripping", () => {
  test("strips a simple import.meta.hot block", () => {
    const code = `
      export const App = () => null;
      if (import.meta.hot) {
        import.meta.hot.accept();
      }
    `;
    const result = transform(code);
    expect(result).not.toContain("import.meta.hot");
  });

  test("strips a block with nested braces", () => {
    const code = `
      export const App = () => null;
      if (import.meta.hot) {
        import.meta.hot.accept(() => {
          if (true) {
            console.log({ nested: { deep: true } });
          }
        });
      }
    `;
    const result = transform(code);
    expect(result).not.toContain("import.meta.hot");
  });

  test("preserves code written AFTER the block", () => {
    const code = `
      if (import.meta.hot) {
        import.meta.hot.accept();
      }
      export const PRESERVED = "yes";
    `;
    const result = transform(code);
    expect(result).not.toContain("import.meta.hot");
    expect(result).toContain("PRESERVED");
  });

  test("strips multiple import.meta.hot blocks", () => {
    const code = `
      export const App = () => null;
      if (import.meta.hot) { import.meta.hot.accept(); }
      export const Other = () => null;
      if (import.meta.hot) { import.meta.hot.dispose(() => {}); }
    `;
    const result = transform(code);
    expect(result).not.toContain("import.meta.hot");
  });
});

// ---------------------------------------------------------------------------
// Relative import rewriting
// Browser modules cannot import via filesystem paths — all relative imports
// within pagesDir are rewritten to /_modules/src/ HTTP URLs.
// ---------------------------------------------------------------------------
describe("relative import rewriting", () => {
  test("rewrites a sibling page import to /_modules/src/ URL", () => {
    // ./utils → /fake/project/src/pages/utils (inside pagesDir) → rewrite.
    // Re-export keeps Babel from dropping the unused import binding.
    const result = transform(`import { helper } from "./utils";\nexport { helper };`);
    expect(result).toContain("/_modules/src/pages/utils");
    expect(result).not.toContain(`from "./utils"`);
  });

  test("rewrites a subdirectory-relative import to /_modules/src/ URL", () => {
    // File at pages/dashboard/index.tsx, ./utils → pages/dashboard/utils → rewrite
    const file = "/fake/project/src/pages/dashboard/index.tsx";
    const result = transform(`import { helper } from "./utils";\nexport { helper };`, { file });
    expect(result).toContain("/_modules/src/pages/dashboard/utils");
  });

  test("rewrites an import that resolves outside pagesDir but inside srcDir to /_modules/src/ URL", () => {
    // File at pages/dashboard/index.tsx, ../../db → /fake/project/src/db
    // Inside srcDir but outside pagesDir — transform rewrites to /_modules/src/ URL.
    // Non-page files are handled separately (bundled via Bun.build) by getTransformedModule.
    const file = "/fake/project/src/pages/dashboard/index.tsx";
    const result = transform(`import { db } from "../../db";\nexport { db };`, { file });
    expect(result).not.toContain(`from "../../db"`);
    expect(result).toContain("/_modules/src/db");
  });

  test("does not rewrite bare specifier (non-relative) imports", () => {
    const result = transform(`import something from "some-package";\nexport const x = 1;`);
    expect(result).not.toContain("/_modules/src/some-package");
  });
});

// ---------------------------------------------------------------------------
// Output shape invariants
// These are the contracts the client runtime depends on.
// ---------------------------------------------------------------------------
describe("output shape invariants", () => {
  test("returns a non-empty string for minimal valid input", () => {
    const result = transform("export const x = 1;");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("output starts with the HMR runtime comment", () => {
    const result = transform("export const x = 1;");
    expect(result.trimStart()).toMatch(HMR_RUNTIME_COMMENT_RE);
  });

  test("output contains inline source map", () => {
    const result = transform("export const x = 1;");
    expect(result).toContain("sourceMappingURL=data:application/json");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
describe("error handling", () => {
  test("throws on completely invalid JavaScript syntax", () => {
    expect(() => transform("<<< this >>< is >< not valid >< javascript >>>")).toThrow();
  });
});
