import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanPages } from "../../../src/server/router/discovery.ts";
import {
  createTmpApp,
  removeAppPath,
  type TmpApp,
  writeAppFile,
} from "../../support/app-fixtures.ts";
import { withBuildStub } from "../../support/with-build-stub.ts";

const { buildPackageTarget } = await import("../../../src/adapter/package.ts");

const tmpApps: TmpApp[] = [];

function trackedTmpApp(fixtureName: string): TmpApp {
  const app = createTmpApp(fixtureName);
  tmpApps.push(app);
  return app;
}

async function buildPackage(appPath: string, prefix: string) {
  const { root, routes } = await scanPages(join(appPath, "src/pages"));
  return await withBuildStub(() =>
    buildPackageTarget(
      { pagesDir: join(appPath, "src/pages"), prefix, root, routes },
      appPath,
      join(appPath, ".furin/build"),
      { target: "package" },
    ),
  );
}

function cleanupTmpApps(): void {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
}

process.on("exit", cleanupTmpApps);

async function runBuildPackageTargetScenarios(): Promise<void> {
  {
    const app = trackedTmpApp("cli-app");
    await buildPackage(app.path, "/shop");
    expect(existsSync(join(app.path, ".furin/build/package/public/.gitkeep"))).toBe(true);
  }

  {
    const app = trackedTmpApp("cli-app");
    removeAppPath(app.path, "public");
    const manifest = await buildPackage(app.path, "/shop");
    expect(manifest.buildId).toBeTruthy();
    expect(existsSync(join(app.path, ".furin/build/package/public"))).toBe(false);
  }

  {
    const app = trackedTmpApp("cli-app");
    await buildPackage(app.path, "/shop");
    const factory = readFileSync(join(app.path, ".furin/build/package/index.js"), "utf8");
    const spreadIndex = factory.indexOf("...options");
    expect(spreadIndex).toBeGreaterThan(-1);
    expect(factory.indexOf("pagesDir: PAGES_DIR")).toBeGreaterThan(spreadIndex);
    expect(factory.indexOf('prefix: "/shop"')).toBeGreaterThan(spreadIndex);
    expect(factory.indexOf("clientDir: CLIENT_DIR")).toBeGreaterThan(spreadIndex);
    expect(factory).toContain('export const prefix = "/shop"');
  }

  {
    const app = trackedTmpApp("cli-app");
    await buildPackage(app.path, "/shop");
    const declarations = readFileSync(join(app.path, ".furin/build/package/index.d.ts"), "utf8");
    expect(declarations).toContain('import type { FurinOptions, furin } from "@teyik0/furin"');
    expect(declarations).toContain(
      'export type CreateFurinAppOptions = Omit<FurinOptions, "pagesDir" | "prefix" | "clientDir">',
    );
    expect(declarations).toContain(
      "createFurinApp(options?: CreateFurinAppOptions): ReturnType<typeof furin>",
    );
  }

  {
    const app = trackedTmpApp("cli-app");
    const first = await buildPackage(app.path, "/shop");
    const pagePath = join(app.path, "src/pages/index.tsx");
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      `${readFileSync(pagePath, "utf8")}\n// ssr-only change\n`,
    );
    const second = await buildPackage(app.path, "/shop");
    expect(first.buildId).toBeTruthy();
    expect(second.buildId).toBeTruthy();
    expect(second.buildId).not.toBe(first.buildId);
  }
}

describe.serial("buildPackageTarget", () => {
  test("emits package assets, factory types, and stable build metadata", (done) => {
    runBuildPackageTargetScenarios().then(() => done(), done);
  });
});
