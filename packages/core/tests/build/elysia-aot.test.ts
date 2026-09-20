import { describe, expect, test } from "bun:test";
import { patchElysiaWebSocketStub } from "../../src/build/elysia-aot.ts";

const websocketStub = `function e(){throw new Error("[elysia-aot] WebSocket route builder was stripped (strip mode) but a WS route was used.")}`;

describe("Elysia AOT WebSocket compatibility", () => {
  test("completes the beta.16 no-WebSocket stub without retaining the WS implementation", () => {
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
