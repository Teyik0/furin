import { expect, test } from "bun:test";

const CORE_DIR_SUFFIX_RE = /[\\/]tests(?:[\\/].*)?$/;

const ROUTE_DEPENDENCY_SCENARIOS = `
import { existsSync } from "node:fs";
import { join } from "node:path";
import { computeRouteDependencies } from "./src/server/router/hmr.ts";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const fixturesDir = join(process.cwd(), "tests/fixtures/pages/default");

let pagePath = join(fixturesDir, "nested/deep/index.tsx");
let rootPath = join(fixturesDir, "root.tsx");
let deps = computeRouteDependencies(pagePath, rootPath);
for (const dep of deps) {
  assert(existsSync(dep), "dependency should exist: " + dep);
}
assert(deps.length === 4, "expected 4 dependencies, got " + deps.length);

pagePath = join(fixturesDir, "isr-page.tsx");
rootPath = join(fixturesDir, "root.tsx");
deps = computeRouteDependencies(pagePath, rootPath);
assert(deps.length === 2, "expected 2 dependencies, got " + deps.length);
assert(deps[0] === pagePath, "first dependency should be the page path");
assert(deps[1] === rootPath, "second dependency should be the root path");

process.exit(0);
`;

test("computeRouteDependencies scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "-e", ROUTE_DEPENDENCY_SCENARIOS],
    cwd: import.meta.dir.replace(CORE_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `route dependency subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
});
