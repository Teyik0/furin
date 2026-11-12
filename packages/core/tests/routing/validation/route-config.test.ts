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

export const route = defineRoute("/blog")
  .config({ mode: "ssr" })
  .layout(({ children }) => <section>{children}</section>);
`;

describe("validateRouteConfig", () => {
  test("accepts valid routes and unparseable files", () => {
    const pagesDir = createPages({
      "(admin)/route.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/(admin)")
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`,
      "(admin)/users.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/(admin)/users")
  .config({ mode: "ssr" })
  .page(() => null);
`,
      "blog/route.tsx": BLOG_LAYOUT,
      "blog/draft.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("/blog/draft").config({ mode: `,
      "blog/index.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/blog/")
  .config({ mode: "isr", revalidate: 60 })
  .page(() => null);
`,
      "__root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" })).toEqual([]);
  });

  test("reports a route without its file id, with the exact call to write", () => {
    const pagesDir = createPages({
      "blog/$slug.tsx": `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute()
  .config({ mode: "ssg", params: t.Object({ slug: t.String() }) })
  .page(() => null);
`,
      "blog/route.tsx": BLOG_LAYOUT,
      "__root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" })).toEqual([
      {
        column: 22,
        file: join(pagesDir, "blog/$slug.tsx"),
        line: 4,
        message:
          'defineRoute() must name this file. Its id is "/blog/$slug":\n  defineRoute("/blog/$slug")',
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
      "__root.tsx": ROOT,
      "static.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/static")
  .config({})
  .page(() => <h1>Static</h1>);
`,
    });

    expect(
      validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" }).map(({ line, message }) => ({
        line,
        message,
      }))
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
      "blog/route.tsx": BLOG_LAYOUT,
      "blog/index.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/blog/").page(() => <h1>Blog</h1>);
`,
      "__root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" })).toEqual([
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
      "__root.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/root")
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" })).toEqual([
      {
        column: 22,
        file: join(pagesDir, "__root.tsx"),
        line: 3,
        message:
          'The root layout must use defineRootRoute(), which has no parent layout:\n  import { defineRootRoute } from "@teyik0/furin";\n  export const route = defineRootRoute().config({ mode: "ssr" })',
      },
      {
        column: 22,
        file: join(pagesDir, "about.tsx"),
        line: 3,
        message:
          'defineRootRoute() is reserved for the root layout. Use defineRoute with this file\'s id:\n  import { defineRoute } from "@teyik0/furin";\n  export const route = defineRoute("/about").config({ mode: "ssg" })',
      },
    ]);
  });

  test("reports path params missing from a page's own params schema", () => {
    const page = (id: string, params: string) => `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute(${JSON.stringify(id)})
  .config({ mode: "ssr"${params} })
  .page(() => null);
`;
    const pagesDir = createPages({
      "blog/$.tsx": page("/blog/$", ""),
      "orgs/$org/route.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/orgs/$org")
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`,
      "orgs/$org/members.tsx": page(
        "/orgs/$org/members",
        ", params: t.Object({ org: t.String() })"
      ),
      "orgs/$org/projects/$id.tsx": page(
        "/orgs/$org/projects/$id",
        ", params: t.Object({ org: t.String() })"
      ),
      "orgs/$org/teams/$team.tsx": page("/orgs/$org/teams/$team", ", params: teamParams"),
      "__root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" })).toEqual([
      {
        column: 11,
        file: join(pagesDir, "blog/$.tsx"),
        line: 5,
        message:
          "The path param _splat is missing from this page's params schema. Each page declares every dynamic segment of its path, including those of its layouts. Add to config():\n  params: t.Object({ _splat: t.String() })",
      },
      {
        column: 11,
        file: join(pagesDir, "orgs/$org/projects/$id.tsx"),
        line: 5,
        message:
          "The path param id is missing from this page's params schema. Each page declares every dynamic segment of its path, including those of its layouts. Add to config():\n  params: t.Object({ id: t.String() })",
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
      "__root.tsx": ROOT,
    });

    expect(
      validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" }).map(({ file, line }) => ({
        file,
        line,
      }))
    ).toEqual([
      { file: join(pagesDir, "alias.tsx"), line: 5 },
      { file: join(pagesDir, "client.tsx"), line: 4 },
    ]);
  });

  test("accepts ids that are the file's place in the pages tree", () => {
    const keyed = (id: string, rest: string, terminal: "layout" | "page") =>
      `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute(${JSON.stringify(id)})
  .config({ mode: "ssr"${rest} })
  .${terminal === "layout" ? "layout(({ children }) => children)" : "page(() => null)"};
`;
    const pagesDir = createPages({
      "(shop)/cart.tsx": keyed("/(shop)/cart", "", "page"),
      "(shop)/route.tsx": keyed("/(shop)", "", "layout"),
      "_auth.tsx": keyed("/_auth", "", "layout"),
      "_auth/login.tsx": keyed("/_auth/login", "", "page"),
      "board/$boardId/index.tsx": keyed(
        "/board/$boardId/",
        ", params: t.Object({ boardId: t.String() })",
        "page"
      ),
      "board/route.tsx": keyed("/board", "", "layout"),
      "posts.$postId.tsx": keyed(
        "/posts/$postId",
        ", params: t.Object({ postId: t.String() })",
        "page"
      ),
      "{-$lang}/about.tsx": keyed(
        "/{-$lang}/about",
        ", params: t.Object({ lang: t.Optional(t.String()) })",
        "page"
      ),
      "index.tsx": keyed("/", "", "page"),
      "__root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" })).toEqual([]);
  });

  test("reports a stale id with the file's id, and a layout option", () => {
    const pagesDir = createPages({
      "blog/route.tsx": BLOG_LAYOUT,
      "blog/index.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/posts")
  .config({ mode: "ssg" })
  .page(() => null);
`,
      "blog/latest.tsx": `import { defineRoute } from "@teyik0/furin";
import { route as blogRoute } from "./route";

export const route = defineRoute("/blog/latest")
  .config({ layout: blogRoute, mode: "ssg" })
  .page(() => null);
`,
      "__root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" })).toEqual([
      {
        column: 34,
        file: join(pagesDir, "blog/index.tsx"),
        line: 3,
        message:
          'defineRoute("/posts") does not match this file. Its id is "/blog/":\n  defineRoute("/blog/")',
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
  .page(() => null);
`;
    const pagesDir = createPages({
      "(team)/members.tsx": keyed("/admin/(team)/members"),
      "index.tsx": keyed("/admin/"),
      "__root.tsx": ROOT,
      "users.tsx": keyed("/users"),
    });

    expect(validateRouteConfig({ pagesDir, prefix: "/admin", style: "tanstack" })).toEqual([
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
      "__root.tsx": ROOT,
    });

    expect(validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" })).toEqual([]);
  });
});

describe("validateRouteConfig — styles", () => {
  test("keys a Next.js-style tree with TanStack ids", () => {
    const pagesDir = createPages({
      "board/[boardId]/page.tsx": `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute("/board/[boardId]")
  .config({ mode: "ssr", params: t.Object({ boardId: t.String() }) })
  .page(() => null);
`,
      "board/layout.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/board")
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`,
      "layout.tsx": ROOT,
    });

    expect(
      validateRouteConfig({ pagesDir, prefix: "", style: "nextjs" }).map(({ message }) => message)
    ).toEqual([
      'defineRoute("/board/[boardId]") does not match this file. Its id is "/board/$boardId/":\n  defineRoute("/board/$boardId/")',
    ]);
  });

  test("reports .error() / .notFound() in the nextjs style, which declares boundaries as files", () => {
    const pagesDir = createPages({
      "about/page.tsx": `import { defineRoute } from "@teyik0/furin";

const AboutError = () => null;
export const route = defineRoute("/about/")
  .config({ mode: "ssg" })
  .error(AboutError)
  .page(() => null);
`,
      "contact/page.tsx": `import { defineRoute } from "@teyik0/furin";

const ContactNotFound = () => null;
export const route = defineRoute("/contact/")
  .config({ mode: "ssg" })
  .notFound(ContactNotFound)
  .page(() => null);
`,
      "layout.tsx": ROOT,
    });

    expect(
      validateRouteConfig({ pagesDir, prefix: "", style: "nextjs" }).map(({ message }) => message)
    ).toEqual([
      ".error() is the TanStack style. In the nextjs style, default-export the component from an error.tsx next to this route.",
      ".notFound() is the TanStack style. In the nextjs style, default-export the component from a not-found.tsx next to this route.",
    ]);
    expect(validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" })).not.toContainEqual(
      expect.objectContaining({ message: expect.stringContaining(".error()") })
    );
  });

  test("suggests t.Optional for an optional path param", () => {
    const pagesDir = createPages({
      "__root.tsx": ROOT,
      "{-$lang}/about.tsx": `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/{-$lang}/about")
  .config({ mode: "ssg" })
  .page(() => null);
`,
    });

    expect(
      validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" }).map(({ message }) => message)
    ).toEqual([
      'The path param lang is missing from this page\'s params schema. Each page declares every dynamic segment of its path, including those of its layouts. Add to config():\n  import { t } from "elysia";\n  params: t.Object({ lang: t.Optional(t.String()) })',
    ]);
  });
});

describe("scaffoldEmptyRoutes", () => {
  test("writes a template into whitespace-only route files and leaves other files untouched", () => {
    const pagesDir = createPages({
      "about.tsx": "\n",
      "blog/$slug.tsx": "  ",
      "blog/route.tsx": "",
      "contact.tsx": "// TODO\n",
      "__root.tsx": " \n",
    });

    const written = scaffoldEmptyRoutes({ pagesDir, prefix: "", style: "tanstack" });

    expect(written).toEqual(
      ["__root.tsx", "about.tsx", "blog/$slug.tsx", "blog/route.tsx"].map((file) =>
        join(pagesDir, file)
      )
    );
    expect(readFileSync(join(pagesDir, "contact.tsx"), "utf8")).toBe("// TODO\n");
    expect(
      readFileSync(join(pagesDir, "__root.tsx"), "utf8")
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
      readFileSync(join(pagesDir, "blog/route.tsx"), "utf8")
    ).toBe(`import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/blog")
  .config({ mode: "ssr" })
  .layout(({ children }) => children);
`);
    expect(
      readFileSync(join(pagesDir, "blog/$slug.tsx"), "utf8")
    ).toBe(`import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute("/blog/$slug")
  .config({ mode: "ssg", params: t.Object({ slug: t.String() }) })
  .page(() => null);
`);
    expect(validateRouteConfig({ pagesDir, prefix: "", style: "tanstack" })).toEqual([]);
    expect(scaffoldEmptyRoutes({ pagesDir, prefix: "", style: "tanstack" })).toEqual([]);
  });

  test("writes the prefixed id in an app mounted with a prefix", () => {
    const pagesDir = createPages({ "index.tsx": "", "__root.tsx": ROOT, "users.tsx": "" });

    scaffoldEmptyRoutes({ pagesDir, prefix: "/admin", style: "tanstack" });

    expect(readFileSync(join(pagesDir, "index.tsx"), "utf8")).toContain('defineRoute("/admin/")');
    expect(readFileSync(join(pagesDir, "users.tsx"), "utf8")).toContain(
      'defineRoute("/admin/users")'
    );
    expect(validateRouteConfig({ pagesDir, prefix: "/admin", style: "tanstack" })).toEqual([]);
  });
});

describe("createRouteConfigReporter", () => {
  test("shows the first issue in the dev overlay without touching the file, then clears it once fixed", () => {
    const invalid = `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/about")
  .config({})
  .page(() => null);
`;
    const pagesDir = createPages({ "about.tsx": invalid, "__root.tsx": ROOT });
    const aboutPath = join(pagesDir, "about.tsx");
    const store = new DevDiagnosticStore();
    const events: string[] = [];
    store.subscribe(0, undefined, (event) => {
      events.push(event.type === "error" ? event.diagnostic.message : event.type);
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const report = createRouteConfigReporter({ pagesDir, prefix: "", style: "tanstack" }, store);

    // Messages show paths with POSIX separators (absolute across Windows drives).
    const message = `[furin] ${aboutPath.replaceAll("\\", "/")}:4:11: config() must declare mode ("ssg", "ssr" or "isr"), e.g. mode: "ssg".`;
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
