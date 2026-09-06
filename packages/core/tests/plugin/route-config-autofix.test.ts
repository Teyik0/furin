import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectedLayoutFor,
  fixRouteConfigLayout,
  layoutIdentifierFor,
} from "../../src/plugin/route-config-autofix.ts";

const TMP_ROOT = join(import.meta.dir, "../../.tmp-tests");

function createPages(files: Record<string, string>): { cleanup: () => void; path: string } {
  mkdirSync(TMP_ROOT, { recursive: true });
  const path = mkdtempSync(join(TMP_ROOT, "autofix-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(path, relativePath);
    mkdirSync(absolute.slice(0, absolute.lastIndexOf("/")), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return { cleanup: () => rmSync(path, { force: true, recursive: true }), path };
}

const ROOT_LAYOUT = `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().layout(({ children }) => children);
`;

describe("layoutIdentifierFor", () => {
  test("derives the binding from the layout directory", () => {
    expect(layoutIdentifierFor("/app/pages/root.tsx")).toBe("rootRoute");
    expect(layoutIdentifierFor("/app/pages/board/_route.tsx")).toBe("boardRoute");
    expect(layoutIdentifierFor("/app/pages/docs/api/_route.tsx")).toBe("apiRoute");
    expect(layoutIdentifierFor("/app/pages/[boardId]/_route.tsx")).toBe("boardIdRoute");
  });
});

describe("expectedLayoutFor", () => {
  test("resolves the nearest _route walking up", () => {
    const pages = createPages({
      "board/_route.tsx": "",
      "board/index.tsx": "",
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const expected = expectedLayoutFor(join(pages.path, "board/index.tsx"), pages.path);
      expect(expected?.identifier).toBe("boardRoute");
      expect(expected?.importPath).toBe("./_route");
    } finally {
      pages.cleanup();
    }
  });

  test("resolves JavaScript _route layouts supported by route discovery", () => {
    for (const extension of ["jsx", "js"]) {
      const pages = createPages({
        [`board/_route.${extension}`]: "",
        "board/index.tsx": "",
        "root.tsx": ROOT_LAYOUT,
      });
      try {
        const expected = expectedLayoutFor(join(pages.path, "board/index.tsx"), pages.path);
        expect(expected?.identifier).toBe("boardRoute");
        expect(expected?.importPath).toBe("./_route");
      } finally {
        pages.cleanup();
      }
    }
  });

  test("a _route file references the layout of its PARENT directory", () => {
    const pages = createPages({
      "board/_route.tsx": "",
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const expected = expectedLayoutFor(join(pages.path, "board/_route.tsx"), pages.path);
      expect(expected?.identifier).toBe("rootRoute");
      expect(expected?.importPath).toBe("../root");
    } finally {
      pages.cleanup();
    }
  });

  test("a normal route ending in _route uses its colocated layout", () => {
    const pages = createPages({
      "board/_route.tsx": "",
      "board/edit_route.tsx": "",
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const expected = expectedLayoutFor(join(pages.path, "board/edit_route.tsx"), pages.path);
      expect(expected?.identifier).toBe("boardRoute");
      expect(expected?.importPath).toBe("./_route");
    } finally {
      pages.cleanup();
    }
  });

  test("falls back to the root.tsx convention", () => {
    const pages = createPages({ "about.tsx": "", "root.tsx": ROOT_LAYOUT });
    try {
      const expected = expectedLayoutFor(join(pages.path, "about.tsx"), pages.path);
      expect(expected?.identifier).toBe("rootRoute");
      expect(expected?.importPath).toBe("./root");
    } finally {
      pages.cleanup();
    }
  });

  test("the root layout itself has no expected layout", () => {
    const pages = createPages({ "root.tsx": ROOT_LAYOUT });
    try {
      expect(expectedLayoutFor(join(pages.path, "root.tsx"), pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });
});

describe("fixRouteConfigLayout", () => {
  test("scaffolds an empty root route", () => {
    const pages = createPages({ "root.tsx": "   \n" });
    try {
      const filePath = join(pages.path, "root.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toBe(`import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ));
`);
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("adds the missing layout terminal to an existing root route", () => {
    const pages = createPages({
      "root.tsx": `import { defineRootRoute } from "@teyik0/furin";

export const route = defineRootRoute().config({ mode: "ssr" });
`,
    });
    try {
      const filePath = join(pages.path, "root.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain("<HeadContent />");
      expect(fixed).toContain("<Scripts />");
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("adds config and layout to a bare root route", () => {
    const pages = createPages({
      "root.tsx": `import { defineRootRoute } from "@teyik0/furin";

export const route = defineRootRoute();
`,
    });
    try {
      const filePath = join(pages.path, "root.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain("<HeadContent />");
      expect(fixed).toContain("<Scripts />");
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("upgrades the legacy generated root identity layout", () => {
    const pages = createPages({
      "root.tsx": `import { defineRootRoute } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`,
    });
    try {
      const filePath = join(pages.path, "root.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain("<HeadContent />");
      expect(fixed).toContain("<Scripts />");
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("does not duplicate document component imports when upgrading a root", () => {
    const pages = createPages({
      "root.tsx": `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`,
    });
    try {
      const filePath = join(pages.path, "root.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed?.match(/\bHeadContent\b/g)).toHaveLength(2);
      expect(fixed?.match(/\bScripts\b/g)).toHaveLength(2);
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("scaffolds an empty nested layout", () => {
    const pages = createPages({ "board/_route.tsx": "", "root.tsx": ROOT_LAYOUT });
    try {
      const filePath = join(pages.path, "board/_route.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toBe(`import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .layout(({ children }) => children);
`);
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("scaffolds an empty page as static", () => {
    const pages = createPages({ "about.tsx": "\n", "root.tsx": ROOT_LAYOUT });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toBe(`import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .page(() => null);
`);
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("rejects a page without an ancestor layout", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().page(() => "about");
`,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      expect(() => fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toThrow(
        `${filePath}: no ancestor layout found; create pages/root.tsx`
      );
    } finally {
      pages.cleanup();
    }
  });

  test("injects the missing layout and its import", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute()
  .config({ mode: "ssr" })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('import { route as rootRoute } from "./root";');
      expect(fixed).toContain('config({ layout: rootRoute, mode: "ssr" })');
      // idempotent: second pass changes nothing
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("injects required keys into an empty config object", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().config({}).page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('.config({ layout: rootRoute, mode: "ssg" })');
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("does not mutate unrelated config calls", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";

foo.config({ enabled: true });
export const route = defineRoute()
  .config({ mode: "ssr" })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain("foo.config({ enabled: true })");
      expect(fixed).toContain('config({ layout: rootRoute, mode: "ssr" })');
    } finally {
      pages.cleanup();
    }
  });

  test("reuses an existing binding that already points at the expected module", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as parentRoute } from "./root";

export const route = defineRoute()
  .config({ mode: "ssr" })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(String(readFile(filePath)), filePath, pages.path);
      expect(fixed).toContain("layout: parentRoute");
      expect(fixed).not.toContain("rootRoute");
    } finally {
      pages.cleanup();
    }
  });

  test("repoints a layout reference that targets the wrong module", () => {
    const pages = createPages({
      "board/_route.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().layout(({ children }) => children);
`,
      "board/[id].tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ mode: "ssr", layout: rootRoute })
  .page(() => "post");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "board/[id].tsx");
      const fixed = fixRouteConfigLayout(String(readFile(filePath)), filePath, pages.path);
      expect(fixed).toContain("layout: boardRoute");
      expect(fixed).toContain('import { route as boardRoute } from "./_route";');
    } finally {
      pages.cleanup();
    }
  });

  test("repoints an identifier that is not a route import", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
const selectedLayout = {};
export const route = defineRoute()
  .config({ layout: selectedLayout, mode: "ssg" })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('import { route as rootRoute } from "./root";');
      expect(fixed).toContain('config({ layout: rootRoute, mode: "ssg" })');
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("repoints a wrong layout while also injecting a missing mode and params", () => {
    const pages = createPages({
      "board/_route.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().layout(({ children }) => children);
`,
      "board/[id].tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute })
  .page(() => "post");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "board/[id].tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('mode: "ssg"');
      expect(fixed).toContain("layout: boardRoute");
      // R13: the [id] segment derives a params schema automatically.
      expect(fixed).toContain("id: t.String()");
      expect(fixed).toContain('import { route as boardRoute } from "./_route";');
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("rejects non-identifier layout expressions", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ mode: "ssr", layout: condition ? rootRoute : undefined })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const source = String(readFile(filePath));
      expect(() => fixRouteConfigLayout(source, filePath, pages.path)).toThrow(
        `${filePath}: use a static layout route reference`
      );
    } finally {
      pages.cleanup();
    }
  });

  test("rejects revalidate with an explicit non-isr mode", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg", revalidate: 60 })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      expect(() => fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toThrow(
        `${filePath}: revalidate requires mode isr`
      );
    } finally {
      pages.cleanup();
    }
  });

  test("rejects staticParams with explicit ssr mode", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr", staticParams: () => [] })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      expect(() => fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toThrow(
        `${filePath}: staticParams requires mode ssg or isr`
      );
    } finally {
      pages.cleanup();
    }
  });

  test("allows staticParams with explicit isr mode", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "isr", revalidate: 60, staticParams: () => [] })
  .loader(() => ({ ok: true }))
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      expect(fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("rejects staticParams when a missing mode would infer ssr", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, staticParams: () => [] })
  .loader(() => ({ ok: true }))
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      expect(() => fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toThrow(
        `${filePath}: staticParams requires mode ssg or isr`
      );
    } finally {
      pages.cleanup();
    }
  });

  test("rejects isr mode without revalidate", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "isr" })
  .loader(() => ({ ok: true }))
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      expect(() => fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toThrow(
        `${filePath}: isr requires revalidate > 0 (or use ssg/ssr)`
      );
    } finally {
      pages.cleanup();
    }
  });

  test("rejects a page terminal in a layout convention file", () => {
    const pages = createPages({
      "board/_route.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .page(() => "board");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "board/_route.tsx");
      expect(() => fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toThrow(
        `${filePath}: layout files must end with .layout()`
      );
    } finally {
      pages.cleanup();
    }
  });

  test("rejects a layout terminal in a page convention file", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .layout(({ children }) => children);
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      expect(() => fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toThrow(
        `${filePath}: page files must end with .page()`
      );
    } finally {
      pages.cleanup();
    }
  });

  test("rejects a builder chain that is not exported as const route", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
const hiddenRoute = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      expect(() => fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toThrow(
        `${filePath}: route files must export a route terminal as export const route`
      );
    } finally {
      pages.cleanup();
    }
  });

  test("rejects defineRootRoute outside pages/root", () => {
    const pages = createPages({
      "about.tsx": `import { defineRootRoute } from "@teyik0/furin";
export const route = defineRootRoute()
  .config({ mode: "ssg" })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      expect(() => fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toThrow(
        `${filePath}: use defineRoute + config({ layout }) outside pages/root.tsx`
      );
    } finally {
      pages.cleanup();
    }
  });

  test("returns null for files without defineRoute or without a config object", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().page(() => "about");
`,
      "raw.ts": `import { Elysia } from "elysia";
export const route = { elysia: new Elysia().get("/", () => "raw") };
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const rawPath = join(pages.path, "raw.ts");
      expect(fixRouteConfigLayout(String(readFile(rawPath)), rawPath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("leaves a helper mentioning defineRoute untouched when no root exists", () => {
    const pages = createPages({
      "helper.ts": `// A helper may document defineRoute without declaring a route.
export const builderName = "defineRoute";
`,
    });
    try {
      const filePath = join(pages.path, "helper.ts");
      expect(fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("inserts a full config on a chain without one", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain(`.config({ layout: rootRoute, mode: "ssg" }).page(() => "about")`);
      // idempotent: second pass changes nothing
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("infers ssr for a config-less route with a loader", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().loader(() => ({ ok: true })).page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain(`.config({ layout: rootRoute, mode: "ssr" }).loader(`);
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("infers isr when a loader and revalidate are present", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, revalidate: 60 })
  .loader(() => ({ ok: true }))
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('config({ mode: "isr", layout: rootRoute, revalidate: 60 })');
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("drops dead revalidate when a loader-less route infers ssg", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, revalidate: 60 })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('config({ mode: "ssg", layout: rootRoute })');
      expect(fixed).not.toContain("revalidate");
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("query takes precedence and drops a dead revalidate", () => {
    const pages = createPages({
      "root.tsx": ROOT_LAYOUT,
      "search.tsx": `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, query: t.Object({ q: t.String() }), revalidate: 60 })
  .loader(() => ({ ok: true }))
  .page(() => "search");
`,
    });
    try {
      const filePath = join(pages.path, "search.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('mode: "ssr"');
      expect(fixed).not.toContain("revalidate");
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("adds a layout import without adding an extra blank line", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute().page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain(
        'import { defineRoute } from "@teyik0/furin";\nimport { route as rootRoute } from "./root";\n\nexport'
      );
    } finally {
      pages.cleanup();
    }
  });

  test("rejects more than one route chain in a module", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().page(() => "about");
export const secondaryRoute = defineRoute().page(() => "secondary");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      expect(() => fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toThrow(
        `${filePath}: one route per file`
      );
    } finally {
      pages.cleanup();
    }
  });

  test("injects the missing mode alongside an existing layout", () => {
    const pages = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute })
  .page(() => "about");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "about.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('config({ mode: "ssg", layout: rootRoute })');
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("the root layout file only receives a mode (defineRootRoute)", () => {
    const pages = createPages({
      "root.tsx": `import { defineRootRoute } from "@teyik0/furin";
export const route = defineRootRoute().layout(({ children }) => children);
`,
    });
    try {
      const filePath = join(pages.path, "root.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('.config({ mode: "ssr" })');
      expect(fixed).not.toContain("layout:");
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("rewrites defineRoute to defineRootRoute in pages/root", () => {
    const pages = createPages({
      "root.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().layout(({ children }) => children);
`,
    });
    try {
      const filePath = join(pages.path, "root.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('import { defineRootRoute } from "@teyik0/furin";');
      expect(fixed).toContain('defineRootRoute().config({ mode: "ssr" })');
      expect(fixed).not.toContain("defineRoute");
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("removes a parent layout while rewriting pages/root", () => {
    const pages = createPages({
      "root.tsx": `import { defineRoute } from "@teyik0/furin";
const impossibleParent = {};
export const route = defineRoute()
  .config({ layout: impossibleParent, mode: "ssr" })
  .layout(({ children }) => children);
`,
    });
    try {
      const filePath = join(pages.path, "root.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('import { defineRootRoute } from "@teyik0/furin";');
      expect(fixed).toContain('.config({ mode: "ssr" })');
      expect(fixed).not.toContain("layout: impossibleParent");
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("removes adjacent root-only and dead config properties safely", () => {
    const pages = createPages({
      "root.tsx": `import { defineRoute } from "@teyik0/furin";
const impossibleParent = {};
export const route = defineRoute()
  .config({ layout: impossibleParent, revalidate: 60 })
  .layout(({ children }) => children);
`,
    });
    try {
      const filePath = join(pages.path, "root.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('.config({ mode: "ssr" })');
      expect(fixed).not.toContain("layout: impossibleParent");
      expect(fixed).not.toContain("revalidate");
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("derives params from a dynamic segment and imports t", () => {
    const pages = createPages({
      "board/[id].tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .page(() => "post");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "board/[id].tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain("params: t.Object({ id: t.String() })");
      expect(fixed).toContain('import { t } from "elysia";');
      // idempotent: second pass changes nothing
      expect(fixRouteConfigLayout(fixed ?? "", filePath, pages.path)).toBeNull();
    } finally {
      pages.cleanup();
    }
  });

  test("derives params from nested dynamic segments", () => {
    const pages = createPages({
      "board/_route.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().layout(({ children }) => children);
`,
      "board/[boardId]/card/[cardId].tsx": `import { defineRoute } from "@teyik0/furin";
import { route as boardRoute } from "../../_route";

export const route = defineRoute()
  .config({ layout: boardRoute, mode: "ssr" })
  .page(() => "card");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "board/[boardId]/card/[cardId].tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain("boardId: t.String()");
      expect(fixed).toContain("cardId: t.String()");
    } finally {
      pages.cleanup();
    }
  });

  test("derives the wildcard param from catch-all segments", () => {
    const pages = createPages({
      "docs/[...path].tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .page(() => "docs");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "docs/[...path].tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain('"*": t.String()');
    } finally {
      pages.cleanup();
    }
  });

  test("a _route file derives params from its own directory", () => {
    const pages = createPages({
      "boards/[organizationId]/_route.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .layout(({ children }) => children);
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "boards/[organizationId]/_route.tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain("params: t.Object({ organizationId: t.String() })");
    } finally {
      pages.cleanup();
    }
  });

  test("preserves a user-declared params schema untouched", () => {
    const pages = createPages({
      "posts/[postId].tsx": `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr", params: t.Object({ postId: t.Number() }) })
  .page(() => "post");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "posts/[postId].tsx");
      // The custom schema makes the config complete: the auto-fix changes nothing.
      expect(fixRouteConfigLayout(readFile(filePath), filePath, pages.path)).toBeNull();
      expect(readFile(filePath)).toContain("postId: t.Number()");
    } finally {
      pages.cleanup();
    }
  });

  test("reuses an already-imported t binding instead of injecting another", () => {
    const pages = createPages({
      "board/[id].tsx": `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .page(() => "post");
`,
      "root.tsx": ROOT_LAYOUT,
    });
    try {
      const filePath = join(pages.path, "board/[id].tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain("params: t.Object({ id: t.String() })");
      // exactly one elysia import — no duplicate t injection
      const elysiaImports = fixed?.match(/from "elysia"/g) ?? [];
      expect(elysiaImports.length).toBe(1);
    } finally {
      pages.cleanup();
    }
  });

  test("scaffolds an empty dynamic page with its params schema", () => {
    const pages = createPages({ "posts/[slug].tsx": "", "root.tsx": ROOT_LAYOUT });
    try {
      const filePath = join(pages.path, "posts/[slug].tsx");
      const fixed = fixRouteConfigLayout(readFile(filePath), filePath, pages.path);
      expect(fixed).toContain("params: t.Object({ slug: t.String() })");
      expect(fixed).toContain('import { t } from "elysia"');
    } finally {
      pages.cleanup();
    }
  });
});

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}
