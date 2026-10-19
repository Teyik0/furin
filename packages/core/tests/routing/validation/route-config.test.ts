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

export const route = defineRoute("/blog/_route")
  .config({ mode: "ssr" })
  .layout(({ children }) => <section>{children}</section>);
`;

describe("validateRouteConfig", () => {
  test("accepts valid routes and unparseable files", () => {
    const pagesDir = createPages({
      "(admin)/_route.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/(admin)/_route")
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`,
      "(admin)/users.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/(admin)/users")
  .config({ mode: "ssr" })
  .page(() => null);
`,
      "blog/_route.tsx": BLOG_LAYOUT,
      "blog/draft.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("/blog/draft").config({ mode: `,
      "blog/index.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/blog")
  .config({ mode: "isr", revalidate: 60 })
  .page(() => null);
`,
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "" })).toEqual([]);
  });

  test("reports a route without its file id, with the exact call to write", () => {
    const pagesDir = createPages({
      "blog/[slug].tsx": `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute()
  .config({ mode: "ssg", params: t.Object({ slug: t.String() }) })
  .page(() => null);
`,
      "blog/_route.tsx": BLOG_LAYOUT,
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "" })).toEqual([
      {
        column: 22,
        file: join(pagesDir, "blog/[slug].tsx"),
        line: 4,
        message:
          'defineRoute() must name this file. Its id is "/blog/[slug]":\n  defineRoute("/blog/[slug]")',
      },
    ]);
  });

  test("reports a config without mode, suggesting the mode the runtime would infer", () => {
    const pagesDir = createPages({
      "posts.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/posts")
  .config({ tags: ["posts"] })
  .loader(async () => ({ posts: [] }))
  .page(() => <h1>Posts</h1>);
`,
      "root.tsx": ROOT,
      "static.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/static")
  .config({})
  .page(() => <h1>Static</h1>);
`,
    });

    expect(
      validateRouteConfig({ pagesDir, prefix: "" }).map(({ line, message }) => ({ line, message }))
    ).toEqual([
      {
        line: 4,
        message: 'config() must declare mode ("ssg", "ssr" or "isr"), e.g. mode: "ssr".',
      },
      {
        line: 4,
        message: 'config() must declare mode ("ssg", "ssr" or "isr"), e.g. mode: "ssg".',
      },
    ]);
  });

  test("reports a route chain without config()", () => {
    const pagesDir = createPages({
      "blog/_route.tsx": BLOG_LAYOUT,
      "blog/index.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/blog").page(() => <h1>Blog</h1>);
`,
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "" })).toEqual([
      {
        column: 22,
        file: join(pagesDir, "blog/index.tsx"),
        line: 3,
        message: 'defineRoute() must be followed by config(). Add:\n  .config({ mode: "ssg" })',
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

export const route = defineRoute("/root")
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "" })).toEqual([
      {
        column: 22,
        file: join(pagesDir, "about.tsx"),
        line: 3,
        message:
          'defineRootRoute() is reserved for root.tsx. Use defineRoute with this file\'s id:\n  import { defineRoute } from "@teyik0/furin";\n  export const route = defineRoute("/about").config({ mode: "ssg" })',
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
    const page = (id: string, params: string) => `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute(${JSON.stringify(id)})
  .config({ mode: "ssr"${params} })
  .page(() => null);
`;
    const pagesDir = createPages({
      "blog/[...rest].tsx": page("/blog/[...rest]", ""),
      "orgs/[org]/_route.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/orgs/[org]/_route")
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`,
      "orgs/[org]/members.tsx": page(
        "/orgs/[org]/members",
        ", params: t.Object({ org: t.String() })"
      ),
      "orgs/[org]/projects/[id].tsx": page(
        "/orgs/[org]/projects/[id]",
        ", params: t.Object({ org: t.String() })"
      ),
      "orgs/[org]/teams/[team].tsx": page("/orgs/[org]/teams/[team]", ", params: teamParams"),
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "" })).toEqual([
      {
        column: 11,
        file: join(pagesDir, "blog/[...rest].tsx"),
        line: 5,
        message:
          'The URL segment [...rest] is missing from this page\'s params schema. Each page declares every dynamic segment of its path, including those of its layouts. Add to config():\n  params: t.Object({ "*": t.String() })',
      },
      {
        column: 11,
        file: join(pagesDir, "orgs/[org]/projects/[id].tsx"),
        line: 5,
        message:
          "The URL segment [id] is missing from this page's params schema. Each page declares every dynamic segment of its path, including those of its layouts. Add to config():\n  params: t.Object({ id: t.String() })",
      },
    ]);
  });

  test("checks routes built from a factory alias or imported from @teyik0/furin/client", () => {
    const pagesDir = createPages({
      "alias.tsx": `import { defineRoute } from "@teyik0/furin";

const make = defineRoute;
export const route = make("/alias")
  .config({})
  .page(() => null);
`,
      "client.tsx": `import { defineRoute } from "@teyik0/furin/client";

export const route = defineRoute("/client")
  .config({})
  .page(() => null);
`,
      "root.tsx": ROOT,
    });

    expect(
      validateRouteConfig({ pagesDir, prefix: "" }).map(({ file, line }) => ({ file, line }))
    ).toEqual([
      { file: join(pagesDir, "alias.tsx"), line: 5 },
      { file: join(pagesDir, "client.tsx"), line: 4 },
    ]);
  });

  test("accepts ids that are the file's place in the pages tree", () => {
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

    expect(validateRouteConfig({ pagesDir, prefix: "" })).toEqual([]);
  });

  test("reports a stale id with the file's id, and a layout option", () => {
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

    expect(validateRouteConfig({ pagesDir, prefix: "" })).toEqual([
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

  test("prefixes the ids of an app mounted with a prefix", () => {
    const keyed = (id: string) => `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute(${JSON.stringify(id)})
  .config({ mode: "ssg" })
  .${id.endsWith("/_route") ? "layout(({ children }) => children)" : "page(() => null)"};
`;
    const pagesDir = createPages({
      "(team)/members.tsx": keyed("/admin/(team)/members"),
      "_route.tsx": keyed("/admin/_route"),
      "index.tsx": keyed("/admin"),
      "root.tsx": ROOT,
      "users.tsx": keyed("/users"),
    });

    expect(validateRouteConfig({ pagesDir, prefix: "/admin" })).toEqual([
      {
        column: 34,
        file: join(pagesDir, "users.tsx"),
        line: 3,
        message:
          'defineRoute("/users") does not match this file. Its id is "/admin/users":\n  defineRoute("/admin/users")',
      },
    ]);
  });

  test("reads the top-level route export, not a route binding nested in an export", () => {
    const pagesDir = createPages({
      "about.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/about")
  .config({ mode: "ssg" })
  .page(() => null);

export function preview() {
  const route = defineRoute("/preview").page(() => null);
  return route;
}
`,
      "root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "" })).toEqual([]);
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

    const written = scaffoldEmptyRoutes({ pagesDir, prefix: "" });

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

export const route = defineRoute("/blog/_route")
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`);
    expect(
      readFileSync(join(pagesDir, "blog/[slug].tsx"), "utf8")
    ).toBe(`import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute("/blog/[slug]")
  .config({ mode: "ssg", params: t.Object({ slug: t.String() }) })
  .page(() => null);
`);
    expect(validateRouteConfig({ pagesDir, prefix: "" })).toEqual([]);
    expect(scaffoldEmptyRoutes({ pagesDir, prefix: "" })).toEqual([]);
  });

  test("writes the prefixed id in an app mounted with a prefix", () => {
    const pagesDir = createPages({ "index.tsx": "", "root.tsx": ROOT, "users.tsx": "" });

    scaffoldEmptyRoutes({ pagesDir, prefix: "/admin" });

    expect(readFileSync(join(pagesDir, "index.tsx"), "utf8")).toContain('defineRoute("/admin")');
    expect(readFileSync(join(pagesDir, "users.tsx"), "utf8")).toContain(
      'defineRoute("/admin/users")'
    );
    expect(validateRouteConfig({ pagesDir, prefix: "/admin" })).toEqual([]);
  });
});

describe("createRouteConfigReporter", () => {
  test("shows the first issue in the dev overlay without touching the file, then clears it once fixed", () => {
    const invalid = `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/about")
  .config({})
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
    const report = createRouteConfigReporter({ pagesDir, prefix: "" }, store);

    const message = `[furin] ${aboutPath}:4:11: config() must declare mode ("ssg", "ssr" or "isr"), e.g. mode: "ssg".`;
    try {
      report();
      report();
      expect(readFileSync(aboutPath, "utf8")).toBe(invalid);
      writeFileSync(aboutPath, invalid.replace("{}", '{ mode: "ssg" }'));
      report();

      expect(events).toEqual([message, "ready"]);
      expect(consoleError.mock.calls).toEqual([[message]]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
