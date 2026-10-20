import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildApp } from "../../../src/build/index.ts";
import { ssgRouteCache } from "../../../src/server/cache/ssg.ts";
import { getProductionTemplate } from "../../../src/server/render/template.ts";
import { createTmpApp, type TmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { runProcess } from "../../support/process.ts";

const tmpApps: TmpApp[] = [];

afterEach(() => {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

function createOriginApp(): TmpApp {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);
  // A bundled page module lives under .furin/build; its source lives under src/.
  writeAppFile(
    app.path,
    "src/pages/blog/[slug].tsx",
    `import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

const origin = import.meta.url.includes("/.furin/build/") ? "bundle" : "source";
const phase = process.env.FURIN_TEST_PHASE ?? "unset";

export const route = defineRoute("/blog/[slug]")
  .config({ mode: "ssg", params: t.Object({ slug: t.String() }) })
  .staticParams(() => [{ slug: "hello-world" }])
  .page(() => <article>rendered-from-{origin} during-{phase}</article>);
`
  );
  return app;
}

test("Bun builds prerender SSG pages with the production bundle", async () => {
  const app = createOriginApp();

  await buildApp({ rootDir: app.path, target: "bun" });

  const snapshot = await Bun.file(join(app.path, ".furin/build/bun/furin-prerender.json")).json();
  expect(snapshot[""]["/blog/hello-world"].html).toContain("rendered-from-<!-- -->bundle");
  expect(getProductionTemplate()).toBeNull();
  expect(ssgRouteCache().size).toBe(0);
}, 60_000);

test("package builds prerender SSG pages with the built package", async () => {
  const app = createOriginApp();

  await buildApp({ pagesDir: "src/pages", rootDir: app.path, target: "package" });

  const snapshot = await Bun.file(
    join(app.path, ".furin/build/package/furin-prerender.json")
  ).json();
  expect(snapshot[""]["/blog/hello-world"].html).toContain("rendered-from-<!-- -->bundle");
}, 60_000);

test("static exports render without touching the process's runtime state", async () => {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);

  await buildApp({ rootDir: app.path, staticConfig: { outDir: "dist" }, target: "static" });

  expect(await Bun.file(join(app.path, "dist/blog/hello-world/index.html")).text()).toContain(
    "Blog post page"
  );
  expect(getProductionTemplate()).toBeNull();
  expect(ssgRouteCache().size).toBe(0);
}, 60_000);

test("static exports render SSG pages with a production bundle", async () => {
  const app = createOriginApp();

  await buildApp({ rootDir: app.path, staticConfig: { outDir: "dist" }, target: "static" });

  const html = await Bun.file(join(app.path, "dist/blog/hello-world/index.html")).text();
  expect(html).toContain("rendered-from-<!-- -->bundle");
  expect(existsSync(join(app.path, ".furin/build/static"))).toBe(false);
}, 60_000);

test("static exports render pages in production mode", async () => {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);
  writeAppFile(
    app.path,
    "src/pages/env.tsx",
    `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/env")
  .config({ mode: "ssg" })
  .page(() => <main>node-env-{process.env.NODE_ENV}</main>);
`
  );

  await buildApp({ rootDir: app.path, staticConfig: { outDir: "dist" }, target: "static" });

  const html = await Bun.file(join(app.path, "dist/env/index.html")).text();
  expect(html).toContain("node-env-<!-- -->production");
}, 60_000);

test("static exports never render pages in the build process", async () => {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);
  writeAppFile(
    app.path,
    "src/pages/global.tsx",
    `import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/global")
  .config({ mode: "ssg" })
  .page(() => {
    (globalThis as { __furinStaticRendered?: boolean }).__furinStaticRendered = true;
    return <main>global</main>;
  });
`
  );

  await buildApp({ rootDir: app.path, staticConfig: { outDir: "dist" }, target: "static" });

  expect(await Bun.file(join(app.path, "dist/global/index.html")).text()).toContain("global");
  expect((globalThis as { __furinStaticRendered?: boolean }).__furinStaticRendered).toBeUndefined();
}, 60_000);

test("the Bun server serves the snapshot rendered at build time", async () => {
  const app = createOriginApp();
  process.env.FURIN_TEST_PHASE = "build";
  try {
    await buildApp({ rootDir: app.path, target: "bun" });
  } finally {
    delete process.env.FURIN_TEST_PHASE;
  }

  const result = await runProcess(
    [
      process.execPath,
      "-e",
      'const { default: app } = await import(process.argv[1]); const response = await app.handle(new Request("http://localhost/blog/hello-world")); console.log(await response.text());',
      join(app.path, ".furin/build/bun/_furin-app.js"),
    ],
    { cwd: app.path, env: { FURIN_TEST_PHASE: "runtime" }, timeoutMs: 10_000 }
  );

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("during-<!-- -->build");
}, 60_000);
