import { describe, expect, test } from "bun:test";
import { REFRESH_SETUP_CODE } from "../../src/hmr/refresh-setup";

// ---------------------------------------------------------------------------
// REFRESH_SETUP_CODE
//
// This snippet is served as /__refresh-setup.js and must execute BEFORE React
// DOM loads.  React Refresh runtime hooks into __REACT_DEVTOOLS_GLOBAL_HOOK__
// to connect to the renderer, so the shape of this object is load-bearing.
// ---------------------------------------------------------------------------
describe("REFRESH_SETUP_CODE", () => {
  test("is a non-empty string", () => {
    expect(typeof REFRESH_SETUP_CODE).toBe("string");
    expect(REFRESH_SETUP_CODE.trim().length).toBeGreaterThan(0);
  });

  test("creates __REACT_DEVTOOLS_GLOBAL_HOOK__", () => {
    expect(REFRESH_SETUP_CODE).toContain("__REACT_DEVTOOLS_GLOBAL_HOOK__");
  });

  test("uses idempotent assignment so it is safe to run more than once", () => {
    // The || operator ensures an existing hook is never overwritten
    expect(REFRESH_SETUP_CODE).toContain("||");
  });

  test("sets supportsFiber to true (required by React Refresh)", () => {
    expect(REFRESH_SETUP_CODE).toContain("supportsFiber: true");
  });

  test("initialises renderers as a Map", () => {
    expect(REFRESH_SETUP_CODE).toContain("renderers");
    expect(REFRESH_SETUP_CODE).toContain("new Map()");
  });

  test("implements the inject method for renderer registration", () => {
    expect(REFRESH_SETUP_CODE).toContain("inject:");
  });

  test("implements onScheduleFiberRoot lifecycle callback", () => {
    expect(REFRESH_SETUP_CODE).toContain("onScheduleFiberRoot");
  });

  test("implements onCommitFiberRoot lifecycle callback", () => {
    expect(REFRESH_SETUP_CODE).toContain("onCommitFiberRoot");
  });

  test("implements onCommitFiberUnmount lifecycle callback", () => {
    expect(REFRESH_SETUP_CODE).toContain("onCommitFiberUnmount");
  });

  test("is syntactically valid JavaScript", () => {
    // new Function() parses but does not execute the code
    expect(() => new Function(REFRESH_SETUP_CODE)).not.toThrow();
  });
});
