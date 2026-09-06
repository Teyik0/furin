import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importStampedRouteModule } from "../../../src/server/router/hmr.ts";

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
