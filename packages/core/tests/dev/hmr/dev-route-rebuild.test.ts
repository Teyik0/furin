import { expect, test } from "bun:test";

const ROUTER_TESTS_DIR_RE = /[\\/]tests(?:[\\/].*)?$/;

test("rebuildDevRoute scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
const { rebuildDevRoute } = await import("./src/server/router/hmr.ts");

function makeRuntimeRoute(overrides) {
  return { __type: "FURIN_ROUTE", ...overrides };
}

function makePage(routeOverrides, hasLoader) {
  const page = {
    __type: "FURIN_PAGE",
    _route: makeRuntimeRoute(routeOverrides),
    component: () => null,
  };
  if (hasLoader) {
    page.loader = () => ({});
  }
  return page;
}

function makeBase(mode) {
  return {
    mode,
    page: makePage({}, false),
    path: "/abs/pages/foo.tsx",
    pattern: "/foo",
    routeChain: [makeRuntimeRoute({})],
    segmentBoundaries: [],
  };
}

let base = makeBase("ssr");
let freshPage = makePage({ revalidate: 60 }, true);
let freshChain = [makeRuntimeRoute({})];
let result = rebuildDevRoute(base, freshPage, freshChain);
expect(result.mode).toBe("isr");

base = makeBase("isr");
freshPage = makePage({}, true);
freshChain = [makeRuntimeRoute({})];
result = rebuildDevRoute(base, freshPage, freshChain);
expect(result.mode).toBe("ssr");

base = makeBase("ssr");
freshPage = makePage({ revalidate: 30 }, true);
freshChain = [makeRuntimeRoute({})];
result = rebuildDevRoute(base, freshPage, freshChain);
expect(result.mode).toBe("isr");

base = makeBase("ssr");
freshPage = makePage({}, false);
freshChain = [makeRuntimeRoute({})];
result = rebuildDevRoute(base, freshPage, freshChain);
expect(result.mode).toBe("ssg");

const baseSegmentBoundaries = [{ depth: 0, path: "/abs/pages" }];
const baseError = () => null;
const baseNotFound = () => null;
base = {
  error: baseError,
  mode: "ssr",
  notFound: baseNotFound,
  page: makePage({}, true),
  path: "/abs/pages/foo.tsx",
  pattern: "/foo",
  routeChain: [makeRuntimeRoute({}), makeRuntimeRoute({})],
  segmentBoundaries: baseSegmentBoundaries,
};
freshPage = makePage({ revalidate: 10 }, true);
freshChain = [makeRuntimeRoute({})];
result = rebuildDevRoute(base, freshPage, freshChain);

expect(result.pattern).toBe(base.pattern);
expect(result.path).toBe(base.path);
expect(result.segmentBoundaries).toBe(baseSegmentBoundaries);
expect(result.error).toBe(baseError);
expect(result.notFound).toBe(baseNotFound);
expect(result.page).toBe(freshPage);
expect(result.routeChain).toBe(freshChain);
expect(result.mode).toBe("isr");
process.exit(0);
`,
    ],
    cwd: import.meta.dir.replace(ROUTER_TESTS_DIR_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `dev route rebuild subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
});
