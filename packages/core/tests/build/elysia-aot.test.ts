import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildApp } from "../../src/build/index.ts";
import { patchElysiaWebSocketStub } from "../../src/build/elysia-aot.ts";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { runProcess } from "../support/process.ts";

const websocketStub = `function e(){throw new Error("[elysia-aot] WebSocket route builder was stripped (strip mode) but a WS route was used.")}`;

describe("Elysia AOT WebSocket compatibility", () => {
  test("completes the no-WebSocket stub without retaining the WS implementation", () => {
    const patched = patchElysiaWebSocketStub(websocketStub);

    expect(patched).toContain("export function accumulateWSOptions(){return e()}");
    expect(patched).toContain("export function resolveWSOptions(){return e()}");
    expect(patched).toContain("export function drainWaiters(){return e()}");
    expect(patched).toContain("export function handleWSResponse(){return e()}");
  });

  test("leaves normal modules and already-complete stubs untouched", () => {
    expect(patchElysiaWebSocketStub("export const value = 1")).toBe("export const value = 1");

    const patched = patchElysiaWebSocketStub(websocketStub);
    expect(patchElysiaWebSocketStub(patched)).toBe(patched);
  });
});

test("Vercel marks only the first instance request", async () => {
  const app = createTmpApp("cli-app");
  try {
    await buildApp({ rootDir: app.path, target: "vercel" });
    const functionDir = join(app.path, ".vercel/output/functions/__server.func");
    const handlerPath = join(functionDir, "index.js");
    const serverBundle = readdirSync(functionDir)
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFileSync(join(functionDir, file), "utf8"))
      .join("\n");
    expect(serverBundle).not.toContain("handler compiler JIT was stripped");
    const handler = (await import(pathToFileURL(handlerPath).href)).default;
    const response = await handler.fetch(new Request("http://localhost/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toContain("furin_instance_first_request");
    const nextResponse = await handler.fetch(new Request("http://localhost/"));
    expect(nextResponse.headers.get("server-timing")).not.toContain(
      "furin_instance_first_request"
    );
  } finally {
    app.cleanup();
  }
});

function createInMemoryClientApp(apiConfig: string) {
  const app = createTmpApp("cli-app");
  writeAppFile(
    app.path,
    "src/api.ts",
    `import Elysia from "elysia";
export const api = new Elysia(${apiConfig}).get("/api/message", () => ({ message: "In-memory API" }));`
  );
  writeAppFile(
    app.path,
    "src/server.ts",
    `import { furin } from "@teyik0/furin";
import { treaty } from "@elysia/eden";
import { furinSync } from "@teyik0/furin/client";
import Elysia from "elysia";
import { api } from "./api";

const client = treaty(api).use(furinSync);

export default new Elysia({ name: "fixture-app" })
  .use(api)
  .get("/probe", async () => {
    const { data, error } = await client.api.message.get();
    if (error) throw error.value;
    return data;
  })
  .use(await furin({ pagesDir: import.meta.dir + "/pages" }));`
  );
  return app;
}

test("a Bun build serves an in-memory client of a named plugin the served app uses", async () => {
  const app = createInMemoryClientApp('{ name: "fixture-api" }');
  try {
    await buildApp({ rootDir: app.path, target: "bun" });

    const result = await runProcess(
      [
        process.execPath,
        "-e",
        'const { default: app } = await import(process.argv[1]); const response = await app.handle(new Request("http://localhost/probe")); console.log(response.status, await response.text());',
        join(app.path, ".furin/build/bun/_furin-app.js"),
      ],
      { cwd: app.path, timeoutMs: 10_000 }
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('200 {"message":"In-memory API"}');
  } finally {
    app.cleanup();
  }
}, 60_000);

test("a build rejects an in-memory client of an unnamed plugin", async () => {
  const app = createInMemoryClientApp("");
  try {
    await expect(buildApp({ rootDir: app.path, target: "bun" })).rejects.toThrow(
      "An in-memory client calls an unnamed Elysia instance"
    );
  } finally {
    app.cleanup();
  }
}, 60_000);
