// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { afterAll, describe, expect, expectTypeOf as expectTypeOfInBun, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "elysia";
import { expectTypeOf } from "expect-type";
import { writeRouteTypes } from "../../src/build/route-types.ts";
import { defineRootRoute, defineRoute, type RouteParams } from "../../src/furin.ts";
import { runProcess } from "../support/process.ts";

/**
 * `defineRoute(id)` reads its parent layout, path params and terminal from the
 * generated `FileRoutes`, augmented here as furin-env.d.ts would. The id is
 * type-only: the runtime route does not depend on it.
 */

const root = defineRootRoute()
  .config({ mode: "ssr", query: t.Object({ lang: t.String() }) })
  .layout(({ children }) => children);

const createOrgLayout = () =>
  defineRoute("/[org]/_route")
    .config({ mode: "ssg", params: t.Object({ org: t.Number() }) })
    .loader(() => ({ plan: "pro" as const }))
    .layout(({ children, params, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ org: number }>();
      expectTypeOf(query).toEqualTypeOf<{ lang: string }>();
      return children;
    });
declare const orgLayout: ReturnType<typeof createOrgLayout>;

declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    "/[org]/_route": {
      kind: "layout";
      pattern: "/:org";
      parent: typeof root;
      pathParams: { org: string };
    };
    "/[org]/projects/[projectId]": {
      kind: "page";
      pattern: "/:org/projects/:projectId";
      parent: typeof orgLayout;
      pathParams: { org: string; projectId: string };
    };
  }
}

const assertInheritedFromTree = () => {
  const project = defineRoute("/[org]/projects/[projectId]")
    .config({ mode: "ssr" })
    .loader(async ({ params, plan, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ projectId: string; org: number }>();
      expectTypeOf(query).toEqualTypeOf<{ lang: string }>();
      expectTypeOf(await plan).toEqualTypeOf<"pro">();
      return { name: params.projectId };
    })
    .page(({ name, params, plan }) => {
      expectTypeOf(name).toEqualTypeOf<string>();
      expectTypeOf(plan).toEqualTypeOf<"pro">();
      expectTypeOf(params).toEqualTypeOf<{ projectId: string; org: number }>();
      return null;
    });
  expectTypeOf<RouteParams<typeof project>>().toEqualTypeOf<{
    projectId: string;
    org: number;
  }>();

  const refined = defineRoute("/[org]/projects/[projectId]")
    .config({ mode: "ssg", params: t.Object({ projectId: t.Number() }) })
    .staticParams(({ params }) => {
      expectTypeOf(params).toEqualTypeOf<{ org?: number }>();
      return [{ projectId: 1 }];
    })
    .page(() => null);
  expectTypeOf<RouteParams<typeof refined>>().toEqualTypeOf<{
    org: number;
    projectId: number;
  }>();
};

const assertRejectedWiring = () => {
  // @ts-expect-error every route names its file
  defineRoute();

  defineRoute("/[org]/projects/[projectId]").config({
    // @ts-expect-error the parent layout comes from the pages tree
    layout: orgLayout,
    mode: "ssr",
  });

  defineRoute("/[org]/_route")
    .config({ mode: "ssr" })
    // @ts-expect-error a _route file is a layout
    .page(() => null);

  defineRoute("/[org]/projects/[projectId]")
    .config({ mode: "ssr" })
    // @ts-expect-error a page file cannot end with layout()
    .layout(({ children }) => children);
};

const TEMP_ROOT = mkdtempSync(join(import.meta.dir, "../../.temp-keyed-routes-"));
const CORE_SOURCE = join(import.meta.dir, "../../src");

afterAll(() => {
  rmSync(TEMP_ROOT, { force: true, recursive: true });
});

/** Writes an app (root-mounted pages plus an `/admin` app) and its generated route types. */
function writeKeyedApp(files: { [path: string]: string }): string {
  const directory = mkdtempSync(join(TEMP_ROOT, "app-"));
  const sources = {
    "node_modules/@teyik0/furin/env.d.ts": "export {};\n",
    "node_modules/@teyik0/furin/package.json": JSON.stringify({
      exports: { "./env": { types: "./env.d.ts" } },
      name: "@teyik0/furin",
    }),
    "src/admin/root.tsx": `import { defineRootRoute } from "@teyik0/furin";
export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .loader(() => ({ staff: true }))
  .layout(({ children }) => children);
`,
    "src/pages/root.tsx": `import { defineRootRoute } from "@teyik0/furin";
import { t } from "elysia";
export const route = defineRootRoute()
  .config({ mode: "ssr", query: t.Object({ lang: t.String() }) })
  .loader(() => ({ site: "Furin" }))
  .layout(({ children }) => children);
`,
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        jsx: "react-jsx",
        lib: ["ESNext", "DOM"],
        module: "Preserve",
        moduleResolution: "bundler",
        noEmit: true,
        paths: {
          "@teyik0/furin": [join(CORE_SOURCE, "furin.ts")],
          "@teyik0/furin/routes": [join(CORE_SOURCE, "routes.ts")],
        },
        skipLibCheck: true,
        strict: true,
        target: "ESNext",
        types: [],
      },
      files: [
        join(CORE_SOURCE, "react-dom-edge.d.ts"),
        join(CORE_SOURCE, "rsc/react-server-dom-webpack.d.ts"),
        "furin-env.d.ts",
        "src/admin/root.tsx",
        "src/pages/root.tsx",
        ...Object.keys(files),
      ],
    }),
    ...files,
  };
  for (const [path, contents] of Object.entries(sources)) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), contents);
  }
  writeRouteTypes([], directory, [
    { pagesDir: join(directory, "src/pages"), prefix: "" },
    { pagesDir: join(directory, "src/admin"), prefix: "/admin" },
  ]);
  return directory;
}

async function typecheck(directory: string): Promise<string> {
  const { stderr, stdout } = await runProcess(
    [
      process.execPath,
      join(import.meta.dir, "../../node_modules/typescript/lib/tsc.js"),
      "--project",
      join(directory, "tsconfig.json"),
    ],
    { cwd: directory, timeoutMs: 20_000 }
  );
  return stdout + stderr;
}

describe("keyed defineRoute(id)", () => {
  test("keeps the id type-only: the runtime route does not depend on it", () => {
    const params = t.Object({ org: t.String(), projectId: t.String() });
    const Page = () => null;
    const project = defineRoute("/[org]/projects/[projectId]")
      .config({ mode: "ssr", params, tags: ["projects"] })
      .page(Page);
    const other = defineRoute("/other")
      .config({ mode: "ssr", params, tags: ["projects"] })
      .page(Page);

    const { elysia: projectApp, ...projectFields } = project;
    const { elysia: otherApp, ...otherFields } = other;
    expect<unknown>(projectFields).toEqual(otherFields);
    expect(projectApp.routes.map(({ method, path }) => `${method} ${path}`)).toEqual(
      otherApp.routes.map(({ method, path }) => `${method} ${path}`)
    );
  });

  test("reads parent, path params and terminal from the generated FileRoutes", () => {
    expectTypeOfInBun(assertInheritedFromTree).toBeFunction();
    expectTypeOfInBun(assertRejectedWiring).toBeFunction();
  });

  test("types every mounted app from its generated furin-env.d.ts", async () => {
    const directory = writeKeyedApp({
      "src/admin/users/[id].tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("/admin/users/[id]")
  .config({ mode: "ssr" })
  .page(({ params, staff }) => {
    const id: string = params.id;
    const isStaff: boolean = staff;
    return isStaff ? id : null;
  });
`,
      "src/checks.ts": `import { defineRoute } from "@teyik0/furin";
import { route as blogRoute } from "./pages/blog/_route";

// @ts-expect-error every route names its file
defineRoute();
// @ts-expect-error a stale id is not a key of the generated FileRoutes
defineRoute("/blog");
// @ts-expect-error a prefixed app's ids start with its prefix
defineRoute("/users/[id]");
// @ts-expect-error the parent layout comes from the pages tree
defineRoute("/blog/[slug]").config({ layout: blogRoute, mode: "ssr" });
`,
      "src/pages/blog/[slug].tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("/blog/[slug]")
  .config({ mode: "ssr" })
  .page(({ params, query, section, site }) => {
    const slug: string = params.slug;
    const lang: string = query.lang;
    const names: string[] = [section, site];
    return [slug, lang, ...names].join();
  });
`,
      "src/pages/blog/_route.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("/blog/_route")
  .config({ mode: "ssr" })
  .loader(() => ({ section: "Blog" }))
  .layout(({ children }) => children);
`,
    });

    expect(await typecheck(directory)).toBe("");
  });
});
