import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, type TmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

const tmpApps: TmpApp[] = [];

afterEach(() => {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

function createApp(mounts: string, apps: string): TmpApp {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);
  writeAppFile(
    app.path,
    "src/server.ts",
    `import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";

const app = new Elysia()${mounts};

export default app;
`
  );
  writeAppFile(app.path, "furin.config.ts", `export default { apps: ${apps} };\n`);
  return app;
}

test("the build fails when furin() mounts a prefix config.apps does not build", async () => {
  const app = createApp(
    '.use(await furin({ pagesDir: "./src/pages", prefix: "/shop" }))',
    '[{ pagesDir: "src/pages" }]'
  );

  const result = await runCli(["build", "--target", "bun"], { cwd: app.path });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("furin() mounts in the server entry do not match config.apps");
  expect(result.stderr).toContain('mounted but not built: prefix "/shop"');
  expect(result.stderr).toContain('built but not mounted: prefix "/"');
}, 30_000);

test("the build fails when a prefix is mounted from another pagesDir", async () => {
  const app = createApp(
    '.use(await furin({ pagesDir: "./src/pages" }))',
    '[{ pagesDir: "src/other-pages" }]'
  );
  writeAppFile(
    app.path,
    "src/other-pages/root.tsx",
    `import { defineRootRoute } from "@teyik0/furin";
export const route = defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => <html lang="en"><body>{children}</body></html>);
`
  );

  const result = await runCli(["build", "--target", "bun"], { cwd: app.path });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("furin() mounts in the server entry do not match config.apps");
  expect(result.stderr).toContain("src/pages");
}, 30_000);

test("the build accepts furin() mounts that match config.apps", async () => {
  const app = createApp(
    '.use(await furin({ pagesDir: "./src/pages", prefix: "/shop/" }))',
    '[{ pagesDir: "src/pages", prefix: "/shop" }]'
  );

  const result = await runCli(["build", "--target", "bun"], { cwd: app.path });

  expect(result.exitCode, result.stderr).toBe(0);
}, 30_000);

test("without config.apps, the build mounts what evaluating the server entry registers", async () => {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);
  writeAppFile(
    app.path,
    "src/server.ts",
    `import { furin as mountPages } from "@teyik0/furin";
import { Elysia } from "elysia";

const pagesDir = ["src", "pages"].join("/");
const app = new Elysia().use(await mountPages({ pagesDir, prefix: "/shop" }));

export default app;
`
  );

  const result = await runCli(["build", "--target", "bun"], { cwd: app.path });

  expect(result.exitCode, result.stderr).toBe(0);
  const manifest = (await Bun.file(join(app.path, ".furin/build/manifest.json")).json()) as {
    apps: { pagesDir: string; prefix: string }[];
  };
  expect(manifest.apps.map(({ pagesDir, prefix }) => ({ pagesDir, prefix }))).toEqual([
    { pagesDir: "src/pages", prefix: "/shop" },
  ]);
}, 30_000);

test("the build reports a server entry it cannot evaluate to find furin() mounts", async () => {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);
  writeAppFile(app.path, "src/server.ts", 'throw new Error("DATABASE_URL is not set");\n');

  const result = await runCli(["build", "--target", "bun"], { cwd: app.path });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("to find its furin() mounts failed");
  expect(result.stderr).toContain("DATABASE_URL is not set");
  expect(result.stderr).toContain("config.apps");
}, 30_000);
