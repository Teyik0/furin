/**
 * Unit tests for the multi-instance primitives: prefix normalization, the
 * request scope that binds requests to runtimes, and prefix-keyed compile
 * contexts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  __clearInstanceRegistry,
  allInstances,
  createInstance,
  currentInstance,
  defaultInstanceBucket,
  enterRequestScope,
  type FurinInstance,
  normalizePrefix,
  registerInstance,
  requestPendingInvalidations,
  scopedInstance,
  withInstance,
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
    // matches isWithinPrefix's boundary checks (silently dead mount).
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

/** Applies one wrap per runtime, outermost first, as Elysia does, then reads the owner. */
function scopeFor(runtimes: FurinInstance[], path: string): FurinInstance | undefined {
  const request = new Request(`http://furin${path}`);
  const enter = (index: number): FurinInstance | undefined => {
    const runtime = runtimes[index];
    return runtime ? enterRequestScope(runtime, request, () => enter(index + 1)) : scopedInstance();
  };
  return enter(0);
}

describe("runtime binding", () => {
  test("code outside any scope uses the default bucket only while no runtime exists", () => {
    expect(currentInstance()).toBe(defaultInstanceBucket());
    registerInstance(createInstance("/admin", "/apps/admin"));
    expect(() => currentInstance()).toThrow("No Furin runtime is bound here");
  });

  test("withInstance binds code to an explicit runtime", () => {
    const admin = registerInstance(createInstance("/admin", "/apps/admin"));
    expect(withInstance(admin, () => currentInstance())).toBe(admin);
  });

  test("the longest declared prefix owns a request whatever the wrap order", () => {
    const root = createInstance("", "/apps/front");
    const admin = createInstance("/admin", "/apps/admin");
    expect(scopeFor([root, admin], "/admin/users")).toBe(admin);
    expect(scopeFor([admin, root], "/admin/users")).toBe(admin);
    expect(scopeFor([root, admin], "/administration")).toBe(root);
  });

  test("a parent route outside every prefix has no owning runtime", () => {
    const admin = createInstance("/admin", "/apps/admin");
    const shop = createInstance("/shop", "/apps/shop");
    expect(scopeFor([admin, shop], "/health")).toBeUndefined();
  });

  test("an in-process request shares its parent's pending invalidations", () => {
    const root = createInstance("", "/apps/front");
    const outer = new Request("http://furin/page");
    const inner = new Request("http://furin/api");
    const [outerPending, innerPending] = enterRequestScope(root, outer, () => [
      requestPendingInvalidations(),
      enterRequestScope(root, inner, () => requestPendingInvalidations()),
    ]);
    expect(innerPending).toBe(outerPending);
  });

  test("request-scoped helpers see the runtimes composed with the request", () => {
    const root = registerInstance(createInstance("", "/apps/front"));
    const admin = createInstance("/admin", "/apps/admin");
    registerInstance(createInstance("/elsewhere", "/apps/elsewhere"));
    const request = new Request("http://furin/admin");
    const peers = enterRequestScope(root, request, () =>
      enterRequestScope(admin, request, () => allInstances())
    );
    expect(peers).toEqual([root, admin]);
  });
});

function makeContext(
  rootPath: string,
  prefix: string | undefined,
  buildId: string
): CompileContext {
  return { buildId, modules: {}, prefix, rootPath, routes: [] };
}

describe("compile contexts keyed by the declared prefix", () => {
  test("the same pagesDir mounted at two prefixes keeps two distinct contexts", () => {
    __setCompileContext(makeContext("/apps/site/src/pages/root.tsx", "", "build-root"));
    __setCompileContext(makeContext("/apps/site/src/pages/root.tsx", "/mirror", "build-mirror"));

    expect(getCompileContext("/apps/site/src/pages", "")?.buildId).toBe("build-root");
    expect(getCompileContext("/apps/site/src/pages", "/mirror")?.buildId).toBe("build-mirror");
  });

  test("deployed binaries resolve by the stable prefix when the pagesDir differs", () => {
    __setCompileContext(makeContext("/build/app/src/pages/root.tsx", "/admin", "build-admin"));
    __setCompileContext(makeContext("/build/front/src/pages/root.tsx", "", "build-front"));

    expect(getCompileContext("/deploy/cwd/src/pages", "/admin")?.buildId).toBe("build-admin");
  });

  test("a context built for another prefix never answers", () => {
    __setCompileContext(makeContext("/apps/only/src/pages/root.tsx", "/admin", "only"));

    expect(getCompileContext("/apps/only/src/pages", "")).toBeNull();
    expect(getCompileContext("/apps/only/src/pages", "/other")).toBeNull();
  });

  test("independent apps sharing a prefix need their own pagesDir", () => {
    __setCompileContext(makeContext("/build/a/src/pages/root.tsx", "", "build-a"));
    __setCompileContext(makeContext("/build/b/src/pages/root.tsx", "", "build-b"));
    expect(getCompileContext("/build/b/src/pages", "")?.buildId).toBe("build-b");
    expect(() => getCompileContext("/deploy/cwd/src/pages", "")).toThrow(
      "2 compiled apps are registered"
    );
  });

  test("module lookups without a mount use the sole compiled app", () => {
    __setCompileContext(makeContext("/apps/only/src/pages/root.tsx", undefined, "only"));
    expect(getCompileContext()?.buildId).toBe("only");
    __setCompileContext(makeContext("/apps/other/src/pages/root.tsx", "/other", "other"));
    expect(getCompileContext()).toBeNull();
  });
});
