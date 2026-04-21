/**
 * Proves the bug and verifies the fix for useLogger() in synthetic render contexts.
 *
 * Bug: useLogger() from evlog/elysia throws when called outside a live Elysia
 * request (ISR background revalidation, SSG pre-renders). Both code paths go
 * through renderForPath() which creates a synthetic context — evlog's ALS is empty.
 *
 * Fix: context-logger.ts wraps useLogger with a fallback to a detached createLogger()
 * instance scoped to the render (via runInSyntheticRenderScope), whose wide event is
 * emitted to the configured drain at the end of the render.
 *
 * NOTE: render.test.ts mocks evlog/elysia with a no-op stub. Bun reuses workers across
 * test files, so that mock can leak here. We override it at the top of this file to
 * restore the throw-outside-context behaviour these tests depend on.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

// Must appear before any import that pulls in evlog/elysia (Bun hoists mock.module).
// Reproduces the real evlog behaviour: useLogger() throws when called outside a
// request context (no evlog ALS entry). This ensures the tests are not affected by
// the no-op stub that render.test.ts installs for its own purposes.
mock.module("evlog/elysia", () => ({
  useLogger() {
    throw new Error(
      "[evlog] useLogger() was called outside of an evlog plugin context. Make sure app.use(evlog()) is registered before your routes."
    );
  },
  evlog: () => (app: unknown) => app,
}));

import { useLogger as evlogUseLogger } from "evlog/elysia";
import { useLogger as furinUseLogger } from "../src/context-logger.ts";
import { prerenderSSG } from "../src/render";
import { __resetCacheState } from "../src/render/cache";
import type { ResolvedRoute } from "../src/router";
import { scanPages } from "../src/router";
import { __setDevMode } from "../src/runtime-env";

const FIXTURES_DIR = `${import.meta.dirname}/fixtures/pages`;

async function getRoute(pattern: string): Promise<ResolvedRoute> {
  const result = await scanPages(FIXTURES_DIR);
  const route = result.routes.find((r) => r.pattern === pattern);
  if (!route) {
    throw new Error(`Route ${pattern} not found`);
  }
  return route;
}

async function getRoot() {
  const result = await scanPages(FIXTURES_DIR);
  return result.root;
}

beforeAll(() => __setDevMode(false));
afterAll(() => __setDevMode(true));
afterEach(() => __resetCacheState());

describe("useLogger() in synthetic render contexts (no evlog ALS)", () => {
  // ── Root cause ──────────────────────────────────────────────────────────────

  test("evlog/elysia useLogger() throws outside a request context", () => {
    expect(() => evlogUseLogger()).toThrow(
      "[evlog] useLogger() was called outside of an evlog plugin context"
    );
  });

  // ── Bug: evlog/elysia import crashes prerenderSSG ───────────────────────────

  test("prerenderSSG crashes when loader imports useLogger from evlog/elysia", async () => {
    const base = await getRoute("/isr-page");
    const root = await getRoot();

    const route: ResolvedRoute = {
      ...base,
      page: {
        ...base.page,
        loader: () => {
          evlogUseLogger().set({ action: "test" });
          return {};
        },
      },
    };

    await expect(prerenderSSG(route, {}, root, "http://localhost", undefined)).rejects.toThrow(
      "[evlog] useLogger() was called outside of an evlog plugin context"
    );
  });

  // ── Fix: context-logger useLogger() works in all contexts ─────────────────

  test("furin useLogger() does not throw outside a request context", () => {
    expect(() => furinUseLogger()).not.toThrow();
  });

  test("furin useLogger() fallback logger methods are all callable without throwing", () => {
    const log = furinUseLogger();
    expect(() => log.set({ foo: "bar" })).not.toThrow();
    expect(() => log.info("msg")).not.toThrow();
    expect(() => log.warn("msg")).not.toThrow();
    expect(() => log.error("err")).not.toThrow();
    expect(() => log.emit()).not.toThrow();
    expect(() => log.getContext()).not.toThrow();
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op for test
    expect(() => log.fork?.("op", () => {})).not.toThrow();
  });

  test("prerenderSSG succeeds when loader uses context-logger useLogger", async () => {
    const base = await getRoute("/isr-page");
    const root = await getRoot();

    const route: ResolvedRoute = {
      ...base,
      page: {
        ...base.page,
        loader: () => {
          furinUseLogger().set({ action: "test" });
          return {};
        },
      },
    };

    await expect(
      prerenderSSG(route, {}, root, "http://localhost", undefined)
    ).resolves.toMatchObject({
      html: expect.stringContaining("<html"),
    });
  });
});
