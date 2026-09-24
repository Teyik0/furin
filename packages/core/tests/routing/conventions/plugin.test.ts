import { expect, test } from "bun:test";

const ROUTER_TESTS_DIR_RE = /[\\/]tests(?:[\\/].*)?$/;

test("createRoutePlugin construction scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { join } from "node:path";
const { scanPages } = await import("./src/server/router/discovery.ts");
const { createRoutePlugin } = await import("./src/server/router/plugin.ts");
const { __setDevMode, IS_DEV } = await import("./src/server/runtime-env.ts");

const fixturesDir = join(import.meta.dir, "tests/fixtures/pages/default");

async function getRoute(pattern) {
  const result = await scanPages(fixturesDir);
  const route = result.routes.find((candidate) => candidate.pattern === pattern);
  if (!route) {
    throw new Error("Route " + pattern + " not found");
  }
  return { root: result.root, route };
}

let routeFixture = await getRoute("/ssg-page");
let plugin = createRoutePlugin(routeFixture.route, routeFixture.root);
expect(plugin).toBeDefined();
expect(typeof plugin.use).toBe("function");
expect(typeof plugin.get).toBe("function");

routeFixture = await getRoute("/ssr-page");
plugin = createRoutePlugin(routeFixture.route, routeFixture.root);
expect(plugin).toBeDefined();
expect(typeof plugin.use).toBe("function");

routeFixture = await getRoute("/isr-page");
plugin = createRoutePlugin(routeFixture.route, routeFixture.root);
expect(plugin).toBeDefined();
expect(typeof plugin.use).toBe("function");

routeFixture = await getRoute("/with-loader");
plugin = createRoutePlugin(routeFixture.route, routeFixture.root);
expect(plugin).toBeDefined();

routeFixture = await getRoute("/nested/deep");
plugin = createRoutePlugin(routeFixture.route, routeFixture.root);
expect(plugin).toBeDefined();

routeFixture = await getRoute("/ssg-page");
plugin = createRoutePlugin(routeFixture.route, routeFixture.root);
expect(plugin).toBeDefined();

const originalDevMode = IS_DEV;
__setDevMode(true);
try {
  routeFixture = await getRoute("/ssg-page");
  plugin = createRoutePlugin(routeFixture.route, routeFixture.root);
  expect(plugin).toBeDefined();
  expect(typeof plugin.use).toBe("function");
} finally {
  __setDevMode(originalDevMode);
}
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
        `router plugin subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
});
