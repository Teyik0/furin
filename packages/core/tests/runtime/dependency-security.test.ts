import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const workspace = resolve(import.meta.dir, "../../../..");

test("Drizzle Kit loads its TypeScript config and generates migrations with the overridden esbuild", async () => {
  const appDir = join(workspace, "examples/task-manager");
  const outDir = mkdtempSync(join(tmpdir(), "furin-drizzle-compat-"));
  const configDir = join(appDir, ".furin", `drizzle-review-${crypto.randomUUID()}`);
  const config = join(configDir, "config.ts");
  try {
    await Bun.write(
      config,
      `import config from "../../drizzle.config.ts"; export default {...config, out: ${JSON.stringify(outDir)}};`
    );
    const child = Bun.spawn(
      [process.execPath, "--bun", "run", "drizzle-kit", "generate", "--config", config],
      {
        cwd: appDir,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stdout + stderr).toBe(0);
    const migrations = Array.from(new Bun.Glob("*.sql").scanSync(outDir));
    expect(migrations).toHaveLength(1);
    const [migration] = migrations;
    if (migration === undefined) {
      throw new Error("Drizzle Kit produced no migration");
    }
    expect(await Bun.file(join(outDir, migration)).text()).toContain("CREATE TABLE");
  } finally {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

function dependencyPath(from: string, names: readonly string[]): string {
  let path = from;
  for (const name of names) {
    path = Bun.resolveSync(name, dirname(path));
  }
  return path;
}

interface SelectorParser {
  astSync: (selector: string) => { first: { nodes: { type: string; value: string }[] } };
  processSync: (selector: string) => string;
}
const parser: () => SelectorParser = require(
  dependencyPath(`${workspace}/apps/docs/package.json`, [
    "@tailwindcss/typography",
    "postcss-selector-parser",
  ])
);

function fastestParse(selector: string): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const start = performance.now();
    parser().astSync(selector);
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

test("selector parsing preserves class/id nodes and has linear flat-selector cost", () => {
  expect(
    parser()
      .astSync("#x.a.b")
      .first.nodes.map(({ type, value }) => [type, value])
  ).toEqual([
    ["id", "x"],
    ["class", "a"],
    ["class", "b"],
  ]);
  const count = 60_000;
  const hostile = fastestParse(".a".repeat(count));
  const control = fastestParse(".a ".repeat(count));
  expect(hostile / Math.max(control, 1)).toBeLessThan(2);
  for (const selector of [
    ".a.a",
    "#x.y",
    ".foo\\:bar:hover",
    ":where(.prose) > h1",
    "a[href='x,y']",
  ]) {
    expect(parser().processSync(selector)).toBe(selector);
  }
});
