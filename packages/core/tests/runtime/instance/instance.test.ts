/**
 * Unit tests for the multi-instance primitives: prefix normalization, path →
 * instance resolution, and (pagesDir, prefix)-keyed compile contexts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  __clearInstanceRegistry,
  allInstances,
  allStateBuckets,
  createInstance,
  currentInstance,
  defaultInstanceBucket,
  normalizePrefix,
  registerInstance,
  resolveInstanceByPath,
  trackInstance,
} from "../../../src/server/instance.ts";
import {
  __resetCompileContext,
  __setCompileContext,
  type CompileContext,
  getCompileContext,
} from "../../../src/server/internal.ts";

afterEach(() => {
  __clearInstanceRegistry();
  __resetCompileContext();
});

describe("normalizePrefix", () => {
  test("accepts root spellings", () => {
    expect(normalizePrefix(undefined)).toBe("");
    expect(normalizePrefix("")).toBe("");
    expect(normalizePrefix("/")).toBe("");
  });

  test("trims a single trailing slash", () => {
    expect(normalizePrefix("/admin")).toBe("/admin");
    expect(normalizePrefix("/admin/")).toBe("/admin");
    expect(normalizePrefix("/admin/v2/")).toBe("/admin/v2");
  });

  test("rejects a double trailing slash instead of trimming it into an unmatchable prefix", () => {
    // "/admin//" trimmed once would yield "/admin/" — a prefix that never
    // matches resolveInstanceByPath's boundary checks (silently dead mount).
    expect(() => normalizePrefix("/admin//")).toThrow('[furin] invalid prefix "/admin//"');
  });

  test("rejects internal double slashes and whitespace", () => {
    expect(() => normalizePrefix("/admin//users")).toThrow("invalid prefix");
    expect(() => normalizePrefix("/ad min")).toThrow("invalid prefix");
  });

  test("rejects prefixes not starting with a slash", () => {
    expect(() => normalizePrefix("admin")).toThrow('must start with "/"');
  });
});

describe("resolveInstanceByPath", () => {
  test("an unmounted runtime does not replace the sole registered instance", () => {
    const mounted = registerInstance(createInstance("/admin", "/apps/admin"));
    const pending = createInstance("/pending", "/apps/pending");
    trackInstance(pending);
    expect(currentInstance()).toBe(mounted);
    expect(allInstances()).toEqual([mounted]);
    expect(resolveInstanceByPath("/pending")).toBe(defaultInstanceBucket());
    expect(allStateBuckets()).toContain(pending);
  });
  test("longest boundary-aware prefix wins", () => {
    const admin = registerInstance(createInstance("/admin", "/apps/admin"));
    const adminV2 = registerInstance(createInstance("/admin/v2", "/apps/admin-v2"));

    expect(resolveInstanceByPath("/admin")).toBe(admin);
    expect(resolveInstanceByPath("/admin/users")).toBe(admin);
    expect(resolveInstanceByPath("/admin/v2/users")).toBe(adminV2);
    // "/administration" shares characters with "/admin" but no path boundary.
    expect(resolveInstanceByPath("/administration")).not.toBe(admin);
  });

  test("falls back to the root instance when one is mounted", () => {
    const root = registerInstance(createInstance("", "/apps/front"));
    registerInstance(createInstance("/admin", "/apps/admin"));

    expect(resolveInstanceByPath("/anything")).toBe(root);
  });

  test("paths outside every mounted prefix resolve to the default bucket, not the first app", () => {
    const admin = registerInstance(createInstance("/admin", "/apps/admin"));
    registerInstance(createInstance("/shop", "/apps/shop"));

    // No root instance is mounted: a parent-Elysia route like "/health" must
    // not bind to whichever furin app registered first — that app's template/
    // cache/build state would leak into routes furin does not own.
    const resolved = resolveInstanceByPath("/health");
    expect(resolved).not.toBe(admin);
    expect(resolved).toBe(defaultInstanceBucket());
  });
});

function makeContext(
  rootPath: string,
  prefix: string | undefined,
  buildId: string
): CompileContext {
  return { buildId, modules: {}, prefix, rootPath, routes: [] };
}

describe("compile contexts keyed by (pagesDir, prefix)", () => {
  test("the same pagesDir mounted at two prefixes keeps two distinct contexts", () => {
    __setCompileContext(makeContext("/apps/site/src/pages/root.tsx", "", "build-root"));
    __setCompileContext(makeContext("/apps/site/src/pages/root.tsx", "/mirror", "build-mirror"));

    expect(getCompileContext("/apps/site/src/pages", "")?.buildId).toBe("build-root");
    expect(getCompileContext("/apps/site/src/pages", "/mirror")?.buildId).toBe("build-mirror");
    // An ambiguous pagesDir-only lookup must not guess between the two mounts.
    expect(getCompileContext("/apps/site/src/pages")).toBeNull();
  });

  test("pagesDir-only match still resolves contexts registered without a prefix", () => {
    __setCompileContext(makeContext("/apps/a/src/pages/root.tsx", undefined, "build-a"));
    __setCompileContext(makeContext("/apps/b/src/pages/root.tsx", "/b", "build-b"));

    // Caller passes a prefix the context was registered without (compile
    // entries generated before the prefix field): the sole pagesDir match wins.
    expect(getCompileContext("/apps/a/src/pages", "/a")?.buildId).toBe("build-a");
    // No prefix passed at all (single-app callers).
    expect(getCompileContext("/apps/b/src/pages")?.buildId).toBe("build-b");
  });

  test("deployed binaries fall back to the stable prefix when the pagesDir key misses", () => {
    __setCompileContext(makeContext("/build/app/src/pages/root.tsx", "/admin", "build-admin"));
    __setCompileContext(makeContext("/build/front/src/pages/root.tsx", "", "build-front"));

    // Different cwd at runtime → the absolute pagesDir misses; the mount
    // prefix is stable across machines and must keep resolving.
    expect(getCompileContext("/deploy/cwd/src/pages", "/admin")?.buildId).toBe("build-admin");
  });

  test("a sole registered context answers any lookup (single-app back-compat)", () => {
    __setCompileContext(makeContext("/apps/only/src/pages/root.tsx", undefined, "only"));

    expect(getCompileContext()?.buildId).toBe("only");
    expect(getCompileContext("/elsewhere/src/pages", "/nope")?.buildId).toBe("only");
  });

  test("does not guess between independent apps sharing a prefix after deployment", () => {
    __setCompileContext(makeContext("/build/a/src/pages/root.tsx", "", "build-a"));
    __setCompileContext(makeContext("/build/b/src/pages/root.tsx", "", "build-b"));
    expect(getCompileContext("/deploy/cwd/src/pages", "")).toBeNull();
    expect(getCompileContext("/build/b/src/pages", "")?.buildId).toBe("build-b");
  });
});
