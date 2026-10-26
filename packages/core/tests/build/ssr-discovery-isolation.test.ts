import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { generateRouteTypes } from "../../src/build/index.ts";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

test("SSR discovery does not acquire application resources and preserves the build", async () => {
  const app = createTmpApp("cli-app");
  try {
    const path = join(app.path, "application.sqlite");
    using database = new Database(path);
    database.exec("CREATE TABLE messages (message TEXT); BEGIN EXCLUSIVE");
    writeAppFile(
      app.path,
      "furin.config.ts",
      'export default { apps: [{ pagesDir: "src/pages" }] };'
    );
    writeAppFile(
      app.path,
      "src/api.ts",
      `import { Database } from "bun:sqlite";
import Elysia from "elysia";
const db = new Database(${JSON.stringify(path)});
db.exec("BEGIN EXCLUSIVE");
export const api = new Elysia({ name: "isolated-api" }).get("/message", () => ({ message: "Ready" }));`
    );
    writeAppFile(
      app.path,
      "src/server.ts",
      `import { Elysia } from "elysia";
import { furin } from "@teyik0/furin";
import { api } from "./api";
export default new Elysia({ name: "isolated-server" }).use(api).use(await furin({ pagesDir: "./src/pages" }));`
    );
    writeAppFile(
      app.path,
      "src/client.ts",
      `import { createIsomorphicFn } from "@teyik0/furin";
import { treaty } from "@elysia/eden";
import { api } from "./api";
export const client = createIsomorphicFn()
  .server(() => treaty(api))
  .client(() => treaty<typeof api>(window.location.origin))();`
    );
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      `import { defineRoute } from "@teyik0/furin";
import { client } from "../client";
export const route = defineRoute("/")
  .config({ mode: "ssr" })
  .loader(async () => {
    const { data, error } = await client.message.get();
    if (error) throw error;
    return data;
  })
  .page(({ message }) => <main>{message}</main>);`
    );
    await generateRouteTypes({ rootDir: app.path, pagesDir: "src/pages" });
    expect(await Bun.file(join(app.path, "furin-env.d.ts")).text()).toContain('"/":');
    database.exec("ROLLBACK");
    const result = await runCli(["build", "--target", "bun", "--output", "app"], { cwd: app.path });
    expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
  } finally {
    app.cleanup();
  }
}, 30_000);
