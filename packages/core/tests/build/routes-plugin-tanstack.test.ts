import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import { createRoutesPlugin } from "../../src/plugin/route-registry.ts";
import { type RouteInstanceSpec, routeModuleSpecifier } from "../../src/plugin/route-tree.ts";

const FURIN_ENTRY = join(import.meta.dir, "../../src/furin.ts");

function layoutModule(id: string): string {
  return `import { defineRoute } from ${JSON.stringify(FURIN_ENTRY)};
export const route = defineRoute(${JSON.stringify(id)}).config({ mode: "ssr" }).layout(({ children }) => children);
`;
}

function pageModule(id: string, params: string[]): string {
  const schema =
    params.length === 0
      ? ""
      : `, params: t.Object({ ${params.map((name) => `${name}: t.Optional(t.String())`).join(", ")} })`;
  return `import { defineRoute } from ${JSON.stringify(FURIN_ENTRY)};
import { t } from "elysia";
export const route = defineRoute(${JSON.stringify(id)}).config({ mode: "ssr"${schema} }).page(() => null);
`;
}

const FILES: { [path: string]: string } = {
  "__root.ts": `import { defineRootRoute } from ${JSON.stringify(FURIN_ENTRY)};
export const route = defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children);
`,
  "_auth.ts": layoutModule("/_auth"),
  "_auth/login.ts": pageModule("/_auth/login", []),
  "docs/$.ts": pageModule("/docs/$", ["_splat"]),
  "posts.$postId.edit.ts": pageModule("/posts/$postId/edit", ["postId"]),
  "posts.index.ts": pageModule("/posts/", []),
  "posts.ts": layoutModule("/posts"),
  "posts_.$postId.raw.ts": pageModule("/posts_/$postId/raw", ["postId"]),
  "{-$lang}/about.ts": pageModule("/{-$lang}/about", ["lang"]),
};

let tempDir: string;
let app: AnyElysia;

beforeAll(async () => {
  tempDir = mkdtempSync(join(import.meta.dir, ".tmp-routes-tanstack-"));
  const pagesDir = join(tempDir, "routes");
  for (const [path, source] of Object.entries(FILES)) {
    mkdirSync(dirname(join(pagesDir, path)), { recursive: true });
    writeFileSync(join(pagesDir, path), source);
  }
  const instance = { pagesDir, prefix: "", style: "tanstack" } satisfies RouteInstanceSpec;
  const entryPath = join(tempDir, "entry.ts");
  writeFileSync(
    entryPath,
    `export { furinApp } from ${JSON.stringify(routeModuleSpecifier(instance))};\n`
  );
  const result = await Bun.build({
    entrypoints: [entryPath],
    naming: "built.js",
    outdir: tempDir,
    plugins: [createRoutesPlugin({ instances: [instance], target: "server" })],
    target: "bun",
  });
  const output = result.outputs.find((artifact) => artifact.kind === "entry-point");
  if (!(result.success && output)) {
    throw new Error("Expected a bundled entry point");
  }
  const built = (await import(`${output.path}?t=${Date.now()}`)) as { furinApp: AnyElysia };
  // Route apps refuse to render outside furin(); echo what the renderer receives.
  app = new Elysia()
    .decorate("$furinRender", (context: { params: unknown }) =>
      Response.json({ params: context.params })
    )
    .use(built.furinApp);
});

afterAll(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

test.each([
  ["/posts", {}],
  ["/posts/7/edit", { postId: "7" }],
  ["/posts/7/raw", { postId: "7" }],
  ["/login", {}],
  ["/about", {}],
  ["/fr/about", { lang: "fr" }],
  ["/docs/guides/routing", { _splat: "guides/routing" }],
])("TanStack-style route tree serves %p", async (path, params) => {
  const response = await app.handle(new Request(`http://localhost${path}`));
  expect(response.status).toBe(200);
  // Elysia passes no params object to a route without path params.
  const body = (await response.json()) as { params?: object };
  expect(body.params ?? {}).toEqual(params);
});

test("pathless and group segments never appear in URLs", async () => {
  const [pathless, unnested] = await Promise.all([
    app.handle(new Request("http://localhost/_auth/login")),
    app.handle(new Request("http://localhost/posts_/7/raw")),
  ]);
  expect(pathless.status).toBe(404);
  expect(unnested.status).toBe(404);
});
