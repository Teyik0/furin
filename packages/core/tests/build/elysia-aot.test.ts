import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildApp } from "../../src/build/index.ts";
import { patchElysiaWebSocketStub } from "../../src/build/elysia-aot.ts";
import { createTmpApp } from "../support/app-fixtures.ts";

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
