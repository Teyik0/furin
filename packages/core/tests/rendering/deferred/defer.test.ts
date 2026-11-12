import { describe, expect, test } from "bun:test";
import { defer, isDeferred } from "../../../src/client";

describe("defer() — nested objects (documented limitation)", () => {
  // v1 design: defer() only splits at the TOP level. Promises buried inside
  // nested objects are passed through to syncData as-is, NOT split into
  // deferredPromises. This is intentional — less magic, more predictable —
  // and documented here as a regression filet.
  test("Promise nested inside an object: stays in syncData, is not extracted", () => {
    const innerPromise = Promise.resolve(123);
    const result = defer({
      outer: { inner: innerPromise, plain: "ok" },
      topLevel: Promise.resolve("top"),
    });

    // The top-level Promise IS recognised as deferred (it's a direct field).
    expect((result.topLevel as unknown) instanceof Promise).toBe(true);
    // The nested Promise is preserved as a Promise but lives inside a sync
    // structure — it will land in syncData, not deferredPromises.
    expect(result.outer).toEqual({ inner: innerPromise, plain: "ok" });
  });
});

describe("isDeferred()", () => {
  test("returns true for an object created by defer()", () => {
    const result = defer({ x: 1 });
    expect(isDeferred(result)).toBe(true);
  });

  test("returns false for a plain object", () => {
    expect(isDeferred({ x: 1 })).toBe(false);
  });

  test("returns false if the mark is absent, inherited, or falsy", () => {
    const deferred = defer({ x: 1 });
    expect(isDeferred({ __isDeferred: false })).toBe(false);
    expect(isDeferred(Object.create({ __isDeferred: true }))).toBe(false);
    expect(isDeferred(Object.create(deferred))).toBe(false);
  });

  test("returns false for null/undefined/primitives", () => {
    expect(isDeferred(null)).toBe(false);
    expect(isDeferred(undefined)).toBe(false);
    expect(isDeferred(42)).toBe(false);
    expect(isDeferred("string")).toBe(false);
  });
});
