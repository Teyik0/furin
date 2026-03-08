import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Elysia from "elysia";
import { buildApp } from "../src/build";
import { elyra } from "../src/elyra";
import { setProductionTemplatePath } from "../src/render/template";
import { __setDevMode } from "../src/runtime-env";
import { createTmpApp, removeAppPath, writeAppFile } from "./helpers/tmp-app";

const tmpApps: Array<{ cleanup: () => void }> = [];
const originalCwd = process.cwd();
const originalBuildOutDir = process.env.ELYRA_BUILD_OUT_DIR;
const originalBuildTarget = process.env.ELYRA_BUILD_TARGET;

function rememberTmpApp<T extends { cleanup: () => void }>(app: T): T {
  tmpApps.push(app);
  return app;
}

afterEach(() => {
  __setDevMode(true);
  setProductionTemplatePath(null);
  process.chdir(originalCwd);

  if (originalBuildOutDir === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to properly unset a variable
    delete process.env.ELYRA_BUILD_OUT_DIR;
  } else {
    process.env.ELYRA_BUILD_OUT_DIR = originalBuildOutDir;
  }

  if (originalBuildTarget === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to properly unset a variable
    delete process.env.ELYRA_BUILD_TARGET;
  } else {
    process.env.ELYRA_BUILD_TARGET = originalBuildTarget;
  }

  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe.serial("elyra()", () => {
  test("writes dev files and returns an Elysia instance in dev mode", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(true);
    process.chdir(app.path);

    const instance = await elyra({
      pagesDir: join(app.path, "src/pages"),
    });

    expect(instance).toBeInstanceOf(Elysia);
    expect(existsSync(join(app.path, ".elyra/index.html"))).toBe(true);
    expect(existsSync(join(app.path, ".elyra/_hydrate.tsx"))).toBe(true);
  });

  test("builds client assets in production when no prebuilt manifest is provided", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);

    const instance = await elyra({
      pagesDir: join(app.path, "src/pages"),
    });

    expect(instance).toBeInstanceOf(Elysia);
    expect(existsSync(join(app.path, ".elyra/client/index.html"))).toBe(true);
  });

  test("uses the prebuilt bun manifest in production and starts successfully", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    await buildApp({
      rootDir: app.path,
      target: "bun",
    });

    __setDevMode(false);
    process.chdir(app.path);
    process.env.ELYRA_BUILD_OUT_DIR = ".elyra/build";
    process.env.ELYRA_BUILD_TARGET = "bun";

    const plugin = await elyra({
      pagesDir: join(app.path, "src/pages"),
    });
    const server = new Elysia().use(plugin).listen(0);

    try {
      await Bun.sleep(50);
      expect(server.server).toBeDefined();
    } finally {
      server.stop();
    }
  }, 10_000);

  test("throws a clear error when no root.tsx is present", () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    removeAppPath(app.path, "src/pages/root.tsx");
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      [
        'import { createRoute } from "elyra/client";',
        "const route = createRoute({ mode: 'ssg' });",
        "export default route.page({ component: () => <main>No root</main> });",
      ].join("\n")
    );
    writeAppFile(
      app.path,
      "src/pages/blog/[slug].tsx",
      [
        'import { createRoute } from "elyra/client";',
        "const route = createRoute({ mode: 'ssg' });",
        "export default route.page({",
        "  staticParams: () => [{ slug: 'hello-world' }],",
        "  component: () => <article>No root blog</article>,",
        "});",
      ].join("\n")
    );
    __setDevMode(true);
    process.chdir(app.path);

    expect(
      elyra({
        pagesDir: join(app.path, "src/pages"),
      })
    ).rejects.toThrow();
  });
});
