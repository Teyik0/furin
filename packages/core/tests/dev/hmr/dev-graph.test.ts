import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevGraph } from "../../../src/server/dev/graph.ts";

interface TestSnapshot {
  value: string;
}

test("DevGraph atomically versions snapshots, modules, state, and events", async () => {
  const graph = new DevGraph<TestSnapshot>({ value: "initial" });
  const imports: string[] = [];
  const importModule = (specifier: string): Promise<{ specifier: string }> => {
    imports.push(specifier);
    return Promise.resolve({ specifier });
  };

  const first = await graph.importModule("/app/page.tsx", "source-v1", importModule);
  const cached = await graph.importModule("/app/page.tsx", "source-v1", importModule);
  graph.commit({ value: "compiled" });
  const updated = await graph.importModule("/app/page.tsx", "source-v2", importModule);
  const firstRevision = graph.sourceVersion("/missing/page.tsx");
  const stableRevision = graph.sourceVersion("/missing/page.tsx");
  graph.invalidateModules();
  const secondRevision = graph.sourceVersion("/missing/page.tsx");

  expect(first).toBe(cached);
  expect(updated).not.toBe(first);
  expect(imports).toHaveLength(2);
  expect(graph.snapshot).toEqual({ value: "compiled" });
  expect(graph.revision).toBe(1);
  expect([firstRevision, stableRevision, secondRevision]).toEqual(["1", "1", "2"]);

  const stateKey = Symbol("loader-cache");
  const cache = graph.state(stateKey, () => new Map<string, number>());
  cache.set("route", 1);
  expect(graph.state(stateKey, () => new Map())).toBe(cache);

  graph.recordImports("/app/page.tsx", ["/app/component.tsx"]);
  graph.recordImports("/app/component.tsx", ["/app/helper.ts"]);
  expect(graph.importChain("/app/page.tsx", "/app/helper.ts")).toEqual([
    "/app/page.tsx",
    "/app/component.tsx",
    "/app/helper.ts",
  ]);

  graph.publishError({
    cause: "dependency failed",
    column: 12,
    file: "src/page.tsx",
    importChain: ["src/page.tsx", "src/component.tsx"],
    line: 7,
    message: "render failed",
    phase: "render",
    route: "/",
    stack: "Error: render failed",
  });

  expect(graph.events.map((event) => event.type)).toEqual(["ready", "error"]);
  expect(graph.events.every((event) => event.revision === 1)).toBe(true);
  expect(graph.metrics).toEqual({
    events: 2,
    modules: 1,
    revision: 1,
  });
});

test("DevGraph versions an entry when a transitive dependency changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-dev-graph-"));
  const entryPath = join(directory, "page.tsx");
  const dependencyPath = join(directory, "component.tsx");
  writeFileSync(entryPath, "export const page = true;\n");
  writeFileSync(dependencyPath, "export const value = 1;\n");
  const graph = new DevGraph<null>(null);
  graph.recordImports(entryPath, [dependencyPath]);

  try {
    const first = graph.sourceVersion(entryPath);
    writeFileSync(dependencyPath, "export const value = 22;\n");
    const second = graph.sourceVersion(entryPath);

    expect(first).toBe("1");
    expect(second).toBe("2");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("DevGraph listeners cannot interrupt a snapshot commit", () => {
  const graph = new DevGraph({ value: "initial" });
  let received = false;
  graph.subscribe(0, () => {
    throw new Error("socket closed");
  });
  graph.subscribe(0, () => {
    received = true;
  });

  expect(() => graph.commit({ value: "ready" })).not.toThrow();
  expect(graph.snapshot).toEqual({ value: "ready" });
  expect(received).toBe(true);
});
