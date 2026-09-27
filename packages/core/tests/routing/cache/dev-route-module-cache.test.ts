import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DevelopmentRouteSnapshot, devGraph } from "../../../src/server/dev/graph.ts";
import { createInstance, withInstance } from "../../../src/server/instance.ts";
import {
  importStampedRouteModule,
  invalidateStampedRouteModules,
} from "../../../src/server/router/hmr.ts";
import { routeModuleSourceVersion } from "../../../src/server/router/source-version.ts";

test("dev route modules are imported once per source version", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-route-module-cache-"));
  const routePath = join(directory, "page.tsx");
  writeFileSync(routePath, "version one\n");
  let imports = 0;
  const resolveImport = (): Promise<Record<string, unknown>> => {
    imports += 1;
    return Promise.resolve({ version: imports });
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

test("invalidating route modules refreshes a route whose dependency changed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-route-module-dependency-"));
  const routePath = join(directory, "page.tsx");
  writeFileSync(routePath, "unchanged route source\n");
  let imports = 0;
  const resolveImport = (): Promise<Record<string, unknown>> => {
    imports += 1;
    return Promise.resolve({ version: imports });
  };

  try {
    const first = await importStampedRouteModule(routePath, resolveImport);
    invalidateStampedRouteModules();
    const refreshed = await importStampedRouteModule(routePath, resolveImport);

    expect(imports).toBe(2);
    expect(refreshed).not.toBe(first);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("refreshing one app keeps another app's route source version", () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-route-module-apps-"));
  const firstPath = join(directory, "first", "page.tsx");
  const secondPath = join(directory, "second", "page.tsx");
  const first = createInstance("/first", join(directory, "first"));
  const second = createInstance("/second", join(directory, "second"));
  const firstGraph = devGraph(first);
  const secondGraph = devGraph(second);
  firstGraph.commit({
    render: () => undefined,
    root: { path: firstPath } as DevelopmentRouteSnapshot["root"],
    routes: [],
  });
  secondGraph.commit({
    render: () => undefined,
    root: { path: secondPath } as DevelopmentRouteSnapshot["root"],
    routes: [],
  });

  try {
    const firstVersion = withInstance(first, () => routeModuleSourceVersion(firstPath));
    const secondVersion = withInstance(second, () => routeModuleSourceVersion(secondPath));

    withInstance(first, invalidateStampedRouteModules);

    expect(withInstance(first, () => routeModuleSourceVersion(firstPath))).not.toBe(firstVersion);
    expect(withInstance(first, () => routeModuleSourceVersion(secondPath))).toBe(secondVersion);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
