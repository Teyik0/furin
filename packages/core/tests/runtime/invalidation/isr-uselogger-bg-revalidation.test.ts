/**
 * Proves the bug and verifies the fix for useLogger() in synthetic render contexts.
 *
 * Bug: useLogger() from evlog/elysia throws when called outside a live Elysia
 * request (ISR background revalidation, SSG pre-renders). Both code paths go
 * through renderForPath() which creates a synthetic context — evlog's ALS is empty.
 *
 * Fix: context-logger.ts exposes getLogger with a fallback to a detached createLogger()
 * instance scoped to the render (via runInSyntheticRenderScope), whose wide event is
 * emitted to the configured drain at the end of the render.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useLogger as evlogUseLogger } from "evlog/elysia";
import { __resetCacheState } from "../../../src/server/cache/invalidation.ts";
import { getLogger as furinGetLogger } from "../../../src/server/context-logger.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";

beforeAll(async () => {
  __setDevMode(false);
  await Promise.resolve();
});
afterAll(async () => {
  __setDevMode(true);
  await Promise.resolve();
});
afterEach(async () => {
  __resetCacheState();
  await Promise.resolve();
});

describe("useLogger() in synthetic render contexts (no evlog ALS)", () => {
  // ── Root cause ──────────────────────────────────────────────────────────────

  test("evlog/elysia useLogger() throws outside a request context", async () => {
    expect(() => evlogUseLogger()).toThrow(
      "[evlog] useLogger() was called outside of an evlog plugin context"
    );
    await Promise.resolve();
  });

  // ── Fix: context-logger getLogger() works in all contexts ─────────────────

  test("furin getLogger() does not throw outside a request context", async () => {
    expect(() => furinGetLogger()).not.toThrow();
    await Promise.resolve();
  });

  test("furin getLogger() fallback logger methods are all callable without throwing", async () => {
    const log = furinGetLogger();
    expect(() => log.set({ foo: "bar" })).not.toThrow();
    expect(() => log.info("msg")).not.toThrow();
    expect(() => log.warn("msg")).not.toThrow();
    expect(() => log.error("err")).not.toThrow();
    expect(() => log.emit()).not.toThrow();
    expect(() => log.getContext()).not.toThrow();
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for test
    expect(() => log.fork?.("op", () => {})).not.toThrow();
    await Promise.resolve();
  });
});
