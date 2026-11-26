import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devGraph } from "../../../src/server/dev/graph.ts";
import type { CompiledModule } from "../../../src/server/internal.ts";
import { importStampedRouteModule } from "../../../src/server/router/hmr.ts";

test("dev route modules are imported once per source version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-route-module-cache-"));
  const routePath = join(directory, "page.tsx");
  writeFileSync(routePath, "version one\n");
  let imports = 0;
  const resolveImport = (): Promise<CompiledModule> => {
    imports += 1;
    return Promise.resolve({ default: imports });
  };

  try {
    const [first, concurrent] = await Promise.all([
      importStampedRouteModule(routePath, resolveImport),
      importStampedRouteModule(routePath, resolveImport),
    ]);

    expect(imports).toBe(1);
    expect(concurrent).toBe(first);

    writeFileSync(routePath, "version two\n");
    const changedAt = new Date(Date.now() + 1000);
    utimesSync(routePath, changedAt, changedAt);
    const changed = await importStampedRouteModule(routePath, resolveImport);

    expect(imports).toBe(2);
    expect(changed).not.toBe(first);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("a route is re-imported when a recorded dependency changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-route-module-dependency-"));
  const routePath = join(directory, "page.tsx");
  const dependencyPath = join(directory, "theme.tsx");
  writeFileSync(routePath, "unchanged route source\n");
  writeFileSync(dependencyPath, "theme v1\n");
  devGraph(undefined).recordImports(routePath, [dependencyPath]);
  let imports = 0;
  const resolveImport = (): Promise<CompiledModule> => {
    imports += 1;
    return Promise.resolve({ default: imports });
  };

  try {
    const first = await importStampedRouteModule(routePath, resolveImport);
    const unchanged = await importStampedRouteModule(routePath, resolveImport);
    writeFileSync(dependencyPath, "theme v2\n");
    const changedAt = new Date(Date.now() + 1000);
    utimesSync(dependencyPath, changedAt, changedAt);
    const refreshed = await importStampedRouteModule(routePath, resolveImport);

    expect(unchanged).toBe(first);
    expect(imports).toBe(2);
    expect(refreshed).not.toBe(first);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
