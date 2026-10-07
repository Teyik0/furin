import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";

const workspace = resolve(import.meta.dir, "../../../..");

function dependencyPath(from: string, names: readonly string[]): string {
  let path = from;
  for (const name of names) {
    path = Bun.resolveSync(name, dirname(path));
  }
  return path;
}

interface BraceAst {
  nodes?: BraceAst[];
  type: string;
  value?: string;
}
interface Braces {
  compile: (pattern: string | BraceAst) => string;
  expand: (pattern: string | BraceAst) => string[];
  stringify: (pattern: string | BraceAst) => string;
}
const braces: Braces = require(
  dependencyPath(`${workspace}/package.json`, [
    "ultracite/biome/core",
    "fast-glob",
    "micromatch",
    "braces",
  ])
);

test("braces rejects excessive nesting through both string and AST entrypoints", () => {
  const pattern = `${"{".repeat(4500)}a${"}".repeat(4500)}`;
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    expect(() => operation(pattern)).toThrow("Brace nesting exceeds maximum depth (128)");
    let ast: BraceAst = { type: "text", value: "a" };
    for (let depth = 0; depth < 200; depth += 1) {
      ast = { type: "root", nodes: [ast] };
    }
    expect(() => operation(ast)).toThrow("Brace nesting exceeds maximum depth (128)");
  }
  expect(braces.expand("src/{client,server}/*.{ts,tsx}")).toEqual([
    "src/client/*.ts",
    "src/client/*.tsx",
    "src/server/*.ts",
    "src/server/*.tsx",
  ]);
});

interface MergeModule {
  deepmerge: (...objects: object[]) => object;
  deepmergeCustom: (options: object) => (...objects: object[]) => object;
  deepmergeInto: (target: object, ...objects: object[]) => void;
  deepmergeIntoCustom: (options: object) => (target: object, ...objects: object[]) => void;
}
const merge: MergeModule = await import(
  dependencyPath(`${workspace}/packages/core/package.json`, [
    "prisma/config",
    "@prisma/config",
    "deepmerge-ts",
  ])
);

test("deepmerge rejects recursive graphs and retains version 7 merge semantics", () => {
  const left: { self?: object } = {};
  left.self = left;
  const right: { self?: object } = {};
  right.self = right;
  for (const operation of [
    merge.deepmerge,
    merge.deepmergeCustom({}),
    merge.deepmergeInto,
    merge.deepmergeIntoCustom({}),
  ]) {
    expect(() => operation(left, right)).toThrow("Cannot merge circular object graphs.");
  }
  const customized = merge.deepmergeCustom({});
  expect(() => customized(left, right)).toThrow("Cannot merge circular object graphs.");
  expect(customized({ a: { b: 1 } }, { a: { c: 2 } })).toEqual({ a: { b: 1, c: 2 } });
  const first = new Map([["nested", { a: 1 }]]);
  const second = new Map([["nested", { b: 2 }]]);
  expect(merge.deepmerge(first, second)).toEqual(second);
  const shared = { nested: { value: 1 } };
  expect(
    merge.deepmerge({ a: shared, b: shared }, { a: { second: true }, b: { third: true } })
  ).toEqual({
    a: { nested: { value: 1 }, second: true },
    b: { nested: { value: 1 }, third: true },
  });
});

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
