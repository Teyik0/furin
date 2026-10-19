import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRouteConfigReporter,
  scaffoldEmptyRoutes,
  validateRouteConfig,
} from "../../../src/plugin/route-config.ts";
import { DevDiagnosticStore } from "../../../src/server/dev/diagnostics.ts";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "furin-route-config-"));

afterAll(() => {
  rmSync(TMP_ROOT, { force: true, recursive: true });
});

function createPages(files: { [relativePath: string]: string }): string {
  const pagesDir = mkdtempSync(join(TMP_ROOT, "pages-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(pagesDir, relativePath);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return pagesDir;
}

const ROOT = `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="en">
      <head><HeadContent /></head>
      <body>{children}<Scripts /></body>
    </html>
  ));
`;

const BLOG_LAYOUT = `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .layout(({ children }) => <section>{children}</section>);
`;

describe("validateRouteConfig", () => {
  test("accepts valid routes, unresolvable layout aliases and unparseable files", () => {
    const pagesDir = createPages({
      "(admin)/_route.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root.tsx";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .layout(({ children }) => children);
`,
      "(admin)/users.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as adminRoute } from "~/pages/(admin)/_route";

export const route = defineRoute()
  .config({ layout: adminRoute, mode: "ssr" })
  .page(() => null);
`,
      "blog/_route.tsx": BLOG_LAYOUT,
      "blog/draft.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute().config({ layout: `,
      "blog/index.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as blogRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: blogRoute, mode: "isr", revalidate: 60 })
  .page(() => null);
`,
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig(pagesDir)).toEqual([]);
  });

  test("reports a layout reference that points at the wrong module", () => {
    const pagesDir = createPages({
      "blog/_route.tsx": BLOG_LAYOUT,
      "blog/index.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .page(() => <h1>Blog</h1>);
`,
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig(pagesDir)).toEqual([
      {
        column: 21,
        file: join(pagesDir, "blog/index.tsx"),
        line: 5,
        message:
          'config({ layout }) must reference the nearest layout, blog/_route.tsx. Import it and pass it:\n  import { route as blogRoute } from "./_route";\n  .config({ layout: blogRoute, ... })',
      },
    ]);
  });

  test("reports a config without layout with the import to add", () => {
    const pagesDir = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute()
  .config({ mode: "ssg" })
  .page(() => <h1>About</h1>);
`,
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig(pagesDir)).toEqual([
      {
        column: 11,
        file: join(pagesDir, "about.tsx"),
        line: 4,
        message:
          'config() must declare layout: the nearest layout is root.tsx. Import it and pass it:\n  import { route as rootRoute } from "./root";\n  .config({ layout: rootRoute, ... })',
      },
    ]);
  });

  test("reports a config without mode, suggesting the mode the runtime would infer", () => {
    const pagesDir = createPages({
      "posts.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute })
  .loader(async () => ({ posts: [] }))
  .page(() => <h1>Posts</h1>);
`,
      "root.tsx": ROOT,
      "static.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute })
  .page(() => <h1>Static</h1>);
`,
    });

    expect(validateRouteConfig(pagesDir).map(({ line, message }) => ({ line, message }))).toEqual([
      {
        line: 5,
        message: 'config() must declare mode ("ssg", "ssr" or "isr"), e.g. mode: "ssr".',
      },
      {
        line: 5,
        message: 'config() must declare mode ("ssg", "ssr" or "isr"), e.g. mode: "ssg".',
      },
    ]);
  });

  test("reports a route chain without config()", () => {
    const pagesDir = createPages({
      "blog/_route.tsx": BLOG_LAYOUT,
      "blog/index.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute().page(() => <h1>Blog</h1>);
`,
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig(pagesDir)).toEqual([
      {
        column: 22,
        file: join(pagesDir, "blog/index.tsx"),
        line: 3,
        message:
          'defineRoute() must be followed by config(). Add:\n  import { route as blogRoute } from "./_route";\n  .config({ layout: blogRoute, mode: "ssg" })',
      },
    ]);
  });

  test("reports the wrong builder for the root layout and for other routes", () => {
    const pagesDir = createPages({
      "about.tsx": `import { defineRootRoute } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssg" })
  .page(() => <h1>About</h1>);
`,
      "root.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`,
    });

    expect(validateRouteConfig(pagesDir)).toEqual([
      {
        column: 22,
        file: join(pagesDir, "about.tsx"),
        line: 3,
        message:
          'defineRootRoute() is reserved for root.tsx. Use defineRoute() with the nearest layout:\n  import { defineRoute } from "@teyik0/furin";\n  import { route as rootRoute } from "./root";\n  export const route = defineRoute().config({ layout: rootRoute, mode: "ssg" })',
      },
      {
        column: 22,
        file: join(pagesDir, "root.tsx"),
        line: 3,
        message:
          'root.tsx must use defineRootRoute(), which has no parent layout:\n  import { defineRootRoute } from "@teyik0/furin";\n  export const route = defineRootRoute().config({ mode: "ssr" })',
      },
    ]);
  });

  test("reports URL segments missing from a page's own params schema", () => {
    const page = (params: string) => `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as orgRoute } from "../_route";

export const route = defineRoute()
  .config({ layout: orgRoute, mode: "ssr"${params} })
  .page(() => null);
`;
    const pagesDir = createPages({
      "blog/[...rest].tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .page(() => null);
`,
      "orgs/[org]/_route.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .layout(({ children }) => children);
`,
      "orgs/[org]/members.tsx": page(", params: t.Object({ org: t.String() })").replace(
        '"../_route"',
        '"./_route"'
      ),
      "orgs/[org]/projects/[id].tsx": page(", params: t.Object({ org: t.String() })"),
      "orgs/[org]/teams/[team].tsx": page(", params: teamParams"),
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig(pagesDir)).toEqual([
      {
        column: 11,
        file: join(pagesDir, "blog/[...rest].tsx"),
        line: 5,
        message:
          'The URL segment [...rest] is missing from this page\'s params schema. Each page declares every dynamic segment of its path, including those of its layouts. Add to config():\n  import { t } from "elysia";\n  params: t.Object({ "*": t.String() })',
      },
      {
        column: 11,
        file: join(pagesDir, "orgs/[org]/projects/[id].tsx"),
        line: 6,
        message:
          "The URL segment [id] is missing from this page's params schema. Each page declares every dynamic segment of its path, including those of its layouts. Add to config():\n  params: t.Object({ id: t.String() })",
      },
    ]);
  });

  test("checks routes built from a factory alias or imported from @teyik0/furin/client", () => {
    const pagesDir = createPages({
      "alias.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

const make = defineRoute;
export const route = make()
  .config({ layout: rootRoute })
  .page(() => null);
`,
      "client.tsx": `import { defineRoute } from "@teyik0/furin/client";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute })
  .page(() => null);
`,
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig(pagesDir).map(({ file, line }) => ({ file, line }))).toEqual([
      { file: join(pagesDir, "alias.tsx"), line: 6 },
      { file: join(pagesDir, "client.tsx"), line: 5 },
    ]);
  });

  test("accepts keyed routes whose id is the file's place in the pages tree", () => {
    const keyed = (id: string, rest: string) => `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute(${JSON.stringify(id)})
  .config({ mode: "ssr"${rest} })
  .${id.endsWith("/_route") ? "layout(({ children }) => children)" : "page(() => null)"};
`;
    const pagesDir = createPages({
      "(shop)/_route.tsx": keyed("/(shop)/_route", ""),
      "(shop)/cart.tsx": keyed("/(shop)/cart", ""),
      "board/[boardId]/index.tsx": keyed(
        "/board/[boardId]",
        ", params: t.Object({ boardId: t.String() })"
      ),
      "board/_route.tsx": keyed("/board/_route", ""),
      "index.tsx": keyed("/", ""),
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig(pagesDir)).toEqual([]);
  });

  test("reports a stale keyed id with the file's id, and a layout option on a keyed route", () => {
    const pagesDir = createPages({
      "blog/_route.tsx": BLOG_LAYOUT,
      "blog/index.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/posts")
  .config({ mode: "ssg" })
  .page(() => null);
`,
      "blog/latest.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as blogRoute } from "./_route";

export const route = defineRoute("/blog/latest")
  .config({ layout: blogRoute, mode: "ssg" })
  .page(() => null);
`,
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig(pagesDir)).toEqual([
      {
        column: 34,
        file: join(pagesDir, "blog/index.tsx"),
        line: 3,
        message:
          'defineRoute("/posts") does not match this file. Its id is "/blog":\n  defineRoute("/blog")',
      },
      {
        column: 13,
        file: join(pagesDir, "blog/latest.tsx"),
        line: 5,
        message:
          "defineRoute(id) reads the parent layout from the pages tree: remove layout from config() and its import.",
      },
    ]);
  });

  test("reads the top-level route export, not a route binding nested in an export", () => {
    const pagesDir = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .page(() => null);

export function preview() {
  const route = defineRoute().page(() => null);
  return route;
}
`,
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig(pagesDir)).toEqual([]);
  });
});

describe("scaffoldEmptyRoutes", () => {
  test("writes a template into whitespace-only route files and leaves other files untouched", () => {
    const pagesDir = createPages({
      "about.tsx": "\n",
      "blog/[slug].tsx": "  ",
      "blog/_route.tsx": "",
      "contact.tsx": "// TODO\n",
      "root.tsx": " \n",
    });

    const written = scaffoldEmptyRoutes(pagesDir);

    expect(written).toEqual(
      ["about.tsx", "blog/_route.tsx", "blog/[slug].tsx", "root.tsx"].map((file) =>
        join(pagesDir, file)
      )
    );
    expect(readFileSync(join(pagesDir, "contact.tsx"), "utf8")).toBe("// TODO\n");
    expect(
      readFileSync(join(pagesDir, "root.tsx"), "utf8")
    ).toBe(`import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";

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
    expect(
      readFileSync(join(pagesDir, "blog/_route.tsx"), "utf8")
    ).toBe(`import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .layout(({ children }) => children);
`);
    expect(
      readFileSync(join(pagesDir, "blog/[slug].tsx"), "utf8")
    ).toBe(`import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as blogRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: blogRoute, mode: "ssg", params: t.Object({ slug: t.String() }) })
  .page(() => null);
`);
    expect(validateRouteConfig(pagesDir)).toEqual([]);
    expect(scaffoldEmptyRoutes(pagesDir)).toEqual([]);
  });
});

describe("createRouteConfigReporter", () => {
  test("shows the first issue in the dev overlay without touching the file, then clears it once fixed", () => {
    const invalid = `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute })
  .page(() => null);
`;
    const pagesDir = createPages({ "about.tsx": invalid, "root.tsx": ROOT });
    const aboutPath = join(pagesDir, "about.tsx");
    const store = new DevDiagnosticStore();
    const events: string[] = [];
    store.subscribe(0, undefined, (event) => {
      events.push(event.type === "error" ? event.diagnostic.message : event.type);
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const report = createRouteConfigReporter(pagesDir, store);

    const message = `[furin] ${aboutPath}:5:11: config() must declare mode ("ssg", "ssr" or "isr"), e.g. mode: "ssg".`;
    try {
      report();
      report();
      expect(readFileSync(aboutPath, "utf8")).toBe(invalid);
      writeFileSync(
        aboutPath,
        invalid.replace("{ layout: rootRoute }", '{ layout: rootRoute, mode: "ssg" }')
      );
      report();

      expect(events).toEqual([message, "ready"]);
      expect(consoleError.mock.calls).toEqual([[message]]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
