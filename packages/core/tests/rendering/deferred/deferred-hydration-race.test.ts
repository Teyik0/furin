import { describe, expect, test } from "bun:test";
import { fromCrossJSON, toCrossJSON } from "seroval";
import {
  buildDeferredResolution,
  buildDeferredScript,
} from "../../../src/server/render/assemble.ts";

const SCRIPT_OPEN_RE = /^<script[^>]*>/;
const SCRIPT_CLOSE_RE = /<\/script>$/;

// ── Race-order tests for the deferred-data hydration registry ─────────────────
//
// Server emits two pieces of JS:
//   1. `buildDeferredScript(keys)` — sets up `window.__FURIN_DEFERRED__`
//      with `_chunks`, `_resolvers`, `resolve()`, `reject()`, `getPromise(key)`.
//   2. One `buildDeferredResolution(key, chunk, action)` per deferred promise,
//      injected as late `<script>` tags at the end of the body.
//
// The client hydration entry (build/hydrate.ts) runs *between* (1) and (2)…
// usually. Race conditions arise when the order shuffles, e.g. a chunk script
// finishes before the entry, or `<Await>` renders + calls `getPromise()` before
// either side has resolved. These tests freeze the four interesting orders so
// any future refactor of the registry must keep them green.

interface DeferredRegistry {
  _chunks: Record<string, { a: 0 | 1; v: unknown }>;
  _deferredKeys: string[];
  _resolvers: Record<
    string,
    {
      promise: Promise<unknown>;
      reject: (reason: unknown) => void;
      resolve: (value: unknown) => void;
    }
  >;
  getPromise: (key: string) => Promise<unknown>;
  reject: (key: string, chunk: unknown) => void;
  resolve: (key: string, chunk: unknown) => void;
}

interface RegistryWindow {
  __FURIN_DEFERRED__?: DeferredRegistry;
}

function bootRegistry(keys: string[]): DeferredRegistry {
  // Execute the server-emitted setup script in a fresh sandbox window. The
  // script body assigns to `window.__FURIN_DEFERRED__`; we simulate the global
  // by passing a local `window` shim.
  const sandboxWindow: RegistryWindow = {};
  const script = buildDeferredScript(keys);
  const body = script.replace(SCRIPT_OPEN_RE, "").replace(SCRIPT_CLOSE_RE, "");
  new Function("window", body)(sandboxWindow);
  if (!sandboxWindow.__FURIN_DEFERRED__) {
    throw new Error("registry not assigned");
  }
  return sandboxWindow.__FURIN_DEFERRED__;
}

/**
 * Applies the patch performed by `build/hydrate.ts` after `buildDeferredScript`
 * has executed: replaces the *stub* `resolve`/`reject` with versions that wake
 * resolvers immediately (instead of just storing chunks). Mirrors lines
 * 145-160 of `build/hydrate.ts` minus the unrelated DOM/React glue.
 */
function applyHydrationPatch(reg: DeferredRegistry): void {
  // Mirrors `packages/core/src/build/hydrate.ts:142-186` — patches resolve/reject
  // and drains queued chunks. Kept in sync intentionally: this test is a filet
  // against regressions in the runtime registry.
  reg.resolve = (key: string, chunk: unknown) => {
    reg.getPromise(key);
    const resolver = reg._resolvers[key];
    if (resolver) {
      resolver.resolve(fromCrossJSON(chunk as never, {}));
    }
  };
  reg.reject = (key: string, chunk: unknown) => {
    reg.getPromise(key);
    const resolver = reg._resolvers[key];
    if (resolver) {
      resolver.reject(fromCrossJSON(chunk as never, {}));
    }
  };
  // Drain any chunks that landed before the patch took effect.
  for (const key of Object.keys(reg._chunks)) {
    const entry = reg._chunks[key];
    if (!entry) {
      continue;
    }
    reg.getPromise(key);
    const resolver = reg._resolvers[key];
    if (!resolver) {
      continue;
    }
    const value = fromCrossJSON(entry.v as never, {});
    if (entry.a === 0) {
      resolver.resolve(value);
    } else {
      resolver.reject(value);
    }
    delete reg._chunks[key];
  }
}

/**
 * Executes a server-emitted resolution `<script>` against the live registry.
 * `buildDeferredResolution(key, chunk, action)` → `<script>window.__FURIN_DEFERRED__.action(key, chunk)</script>`
 */
function runResolutionScript(
  reg: DeferredRegistry,
  key: string,
  value: unknown,
  action: "reject" | "resolve"
): void {
  const chunk = toCrossJSON(value);
  const scriptTag = buildDeferredResolution(key, chunk, action);
  const body = scriptTag.replace(SCRIPT_OPEN_RE, "").replace(SCRIPT_CLOSE_RE, "");
  new Function("window", body)({ __FURIN_DEFERRED__: reg });
}

describe("Deferred hydration registry — race orders", () => {
  test("(a) chunk arrives BEFORE hydrate entry → resolved after patch", async () => {
    const reg = bootRegistry(["stats"]);

    // Server pushes the resolution chunk *before* hydrate.ts runs.
    runResolutionScript(reg, "stats", { count: 42 }, "resolve");

    // Now hydrate runs and patches resolve/reject, draining queued chunks.
    applyHydrationPatch(reg);

    // <Await> mounts and asks for the promise.
    const promise = reg.getPromise("stats");

    await expect(promise).resolves.toEqual({ count: 42 });
  });

  test("(b) chunk arrives AFTER entry, Await mounted BEFORE → resolves when chunk lands", async () => {
    const reg = bootRegistry(["stats"]);
    applyHydrationPatch(reg);

    // <Await> mounts before the late <script> runs.
    const promise = reg.getPromise("stats");

    // Late script fires.
    runResolutionScript(reg, "stats", { count: 99 }, "resolve");

    await expect(promise).resolves.toEqual({ count: 99 });
  });

  test("(c) chunk arrives AFTER entry, Await mounted AFTER the chunk → resolves immediately", async () => {
    const reg = bootRegistry(["stats"]);
    applyHydrationPatch(reg);

    // Late script fires while no <Await> is mounted yet.
    runResolutionScript(reg, "stats", { count: 7 }, "resolve");

    // Now <Await> mounts.
    const promise = reg.getPromise("stats");

    await expect(promise).resolves.toEqual({ count: 7 });
  });

  test("(d) Await mounted, chunk never arrives → stays pending", async () => {
    const reg = bootRegistry(["stats"]);
    applyHydrationPatch(reg);

    const promise = reg.getPromise("stats");

    // Race the promise against a microtask-tick timeout.
    const settled = await Promise.race([
      promise.then(
        () => "resolved" as const,
        () => "rejected" as const
      ),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 30)),
    ]);

    expect(settled).toBe("pending");
  });

  test("rejection: reject chunk before hydrate → useAsyncError receives the error", async () => {
    const reg = bootRegistry(["stats"]);
    runResolutionScript(reg, "stats", new Error("server boom"), "reject");

    applyHydrationPatch(reg);

    const promise = reg.getPromise("stats");
    const err = await promise.then(() => null).catch((e: unknown) => e);

    expect((err as Error).message).toBe("server boom");
  });

  test("multiple keys: mixed orders resolve independently", async () => {
    const reg = bootRegistry(["a", "b", "c"]);

    // "a" arrives before hydrate
    runResolutionScript(reg, "a", "alpha", "resolve");

    applyHydrationPatch(reg);

    // <Await> for "b" mounts before its chunk
    const pB = reg.getPromise("b");

    // "b" arrives
    runResolutionScript(reg, "b", "beta", "resolve");

    // "c" arrives, then <Await> mounts
    runResolutionScript(reg, "c", "gamma", "resolve");
    const pC = reg.getPromise("c");

    // <Await> for "a" mounts late
    const pA = reg.getPromise("a");

    await expect(pA).resolves.toBe("alpha");
    await expect(pB).resolves.toBe("beta");
    await expect(pC).resolves.toBe("gamma");
  });
});
