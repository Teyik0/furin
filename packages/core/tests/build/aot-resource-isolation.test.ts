import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, removeAppPath, writeAppFile } from "../support/app-fixtures.ts";
import { runCli, runProcess } from "../support/process.ts";

test.each(["bun", "vercel"] as const)(
  "%s builds SSR with locked resources and a Sync factory while preserving AOT",
  async (target) => {
    const fixture = createTmpApp("cli-app");
    removeAppPath(fixture.path, "src/pages/blog");
    const path = join(fixture.path, "application.sqlite");
    const database = new Database(path);
    database.exec("CREATE TABLE messages (message TEXT); BEGIN EXCLUSIVE");
    try {
      writeAppFile(
        fixture.path,
        "src/api.ts",
        `import { Database } from "bun:sqlite";
import { furinSync } from "@teyik0/furin/sync";
import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { migrateSqliteSync } from "@teyik0/furin/sync/sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import Elysia, { inAotBuild, t } from "elysia";

let sqlite;
let db;
if (!inAotBuild()) {
  sqlite = new Database(${JSON.stringify(path)});
  sqlite.exec("BEGIN EXCLUSIVE");
  migrateSqliteSync(sqlite);
  db = drizzle(sqlite);
}
export let factoryCalls = 0;
export const sync = {
  adapter: () => {
    if (inAotBuild()) throw new Error("Sync factory ran during AOT");
    factoryCalls += 1;
    if (factoryCalls !== 1) throw new Error("Sync factory ran twice");
    return drizzleSyncAdapter({ db, namespace: "build-isolation" });
  },
  principal: () => "alice",
  secret: "build-isolation-secret-with-at-least-32-characters",
};
export const api = new Elysia({ name: "isolated-api", prefix: "/api" })
  .use(furinSync(sync))
  .get("/message", () => ({ message: "Ready" }))
  .post("/message", {
    body: t.Object({ message: t.String() }),
    response: t.Object({ message: t.String() }),
  }, ({ body, mutation, invalidate }) => mutation(() => {
    sqlite.query("INSERT INTO messages VALUES (?)").run(body.message);
    invalidate("/api/message");
    return { message: body.message };
  }));`
      );
      writeAppFile(
        fixture.path,
        "src/server.ts",
        `import { Elysia } from "elysia";
import { furin } from "@teyik0/furin";
import { api, sync } from "./api";
export default new Elysia({ name: "isolated-server" })
  .use(api)
  .use(await furin({ pagesDir: "./src/pages", sync }));`
      );
      writeAppFile(
        fixture.path,
        "src/client.ts",
        `import { createIsomorphicFn } from "@teyik0/furin";
import { treaty } from "@elysia/eden";
import { api } from "./api";
export const client = createIsomorphicFn()
  .server(() => treaty(api))
  .client(() => treaty<typeof api>(window.location.origin))();`
      );
      writeAppFile(
        fixture.path,
        "src/pages/index.tsx",
        `import { defineRoute } from "@teyik0/furin";
import { client } from "../client";
export const route = defineRoute("/")
  .config({ mode: "ssr" })
  .loader(async () => {
    const { data, error } = await client.api.message.get();
    if (error) throw error;
    return data;
  })
  .page(({ message }) => <main>{message}</main>);`
      );

      const build = await runCli(
        ["build", "--target", target, ...(target === "bun" ? ["--output", "app"] : [])],
        { cwd: fixture.path }
      );
      expect(build.exitCode, `${build.stderr}\n${build.stdout}`).toBe(0);
      database.exec("ROLLBACK");

      const runtime = await runProcess(
        [
          process.execPath,
          "-e",
          `
const { default: app } = await import(process.argv[1]);
globalThis.Function = new Proxy(globalThis.Function, {
  construct() { throw new Error("Unexpected runtime compilation after AOT"); },
  apply() { throw new Error("Unexpected runtime compilation after AOT"); },
});
const handle = request => app.handle ? app.handle(request) : app.fetch(request);
for (const path of ["/", "/api/message"]) {
  const response = await handle(new Request("http://localhost" + path));
  const body = await response.text();
  if (response.status !== 200 || !body.includes("Ready")) throw new Error(body);
}
const invalid = await handle(new Request("http://localhost/api/message", {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
}));
if (invalid.status !== 422) throw new Error("Request validation was lost");
for (let i = 0; i < 2; i++) {
  const response = await handle(new Request("http://localhost/api/message", {
    method: "POST", headers: { "idempotency-key": "once", "content-type": "application/json" },
    body: JSON.stringify({ message: "Written" }),
  }));
  if (response.status !== 200 || (await response.json()).message !== "Written") throw new Error("Mutation failed");
}
const response = await handle(new Request("http://localhost/_furin/sync/changes?after=0"));
const page = await response.json();
if (response.status !== 200 || page.cursor !== "1") throw new Error(JSON.stringify(page));
if (${JSON.stringify(target)} === "bun") {
  app.listen({ port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(app.server.url.origin.replace("http", "ws") + "/_furin/events");
    socket.addEventListener("error", reject);
    socket.addEventListener("message", ({ data }) => {
      const event = JSON.parse(data);
      if (event.channel === "sync" && event.data.cursor === "1") {
        socket.close();
        resolve();
      }
    });
  });
  await app.stop(true);
} else {
  const events = await handle(new Request("http://localhost/_furin/events"));
  if (events.status !== 200) throw new Error("SSE connection failed");
  const reader = events.body.getReader();
  let received = "";
  while (!received.includes('"cursor":"1"')) {
    const { done, value } = await reader.read();
    if (done) throw new Error("SSE closed before its cursor");
    received += new TextDecoder().decode(value);
  }
  await reader.cancel();
}
process.exit(0);`,
          join(
            fixture.path,
            target === "bun"
              ? ".furin/build/bun/app.js"
              : ".vercel/output/functions/__server.func/index.js"
          ),
        ],
        { cwd: fixture.path, env: { NODE_ENV: "production" }, timeoutMs: 10_000 }
      );
      expect(runtime.exitCode, `${runtime.stderr}\n${runtime.stdout}`).toBe(0);
    } finally {
      database.close();
      fixture.cleanup();
    }
  },
  30_000
);
