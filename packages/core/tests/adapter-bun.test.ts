import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildBunTarget } from "../src/adapter/bun.ts";
import type { BuildAppOptions } from "../src/build/types.ts";
import { scanPages } from "../src/router.ts";
import { createTmpApp } from "./helpers/tmp-app.ts";

const tmpApps: Array<{ cleanup: () => void }> = [];
const originalBunBuild = Bun.build;

function rememberTmpApp<T extends { cleanup: () => void }>(app: T): T {
  tmpApps.push(app);
  return app;
}

afterEach(() => {
  Bun.build = originalBunBuild;
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

async function withCompileStub<T>(run: () => Promise<T>): Promise<T> {
  Bun.build = ((config: Bun.BuildConfig) => {
    if ("compile" in config && config.compile) {
      return Promise.resolve({ success: true, outputs: [], logs: [] } as Bun.BuildOutput);
    }
    return originalBunBuild(config);
  }) as typeof Bun.build;

  try {
    return await run();
  } finally {
    Bun.build = originalBunBuild;
  }
}

describe.serial("buildBunTarget compile branches", () => {
  test("throws when compile is enabled without a server entry", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    const options: BuildAppOptions = { target: "bun", compile: "server" };

    await expect(
      buildBunTarget(
        [],
        app.path,
        join(app.path, ".elyra/build"),
        join(app.path, "src/pages/root.tsx"),
        null,
        options
      )
    ).rejects.toThrow("server entry");
  });

  test("compile server keeps client assets on disk", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    await withCompileStub(async () => {
      await buildBunTarget(
        routes,
        app.path,
        join(app.path, ".elyra/build"),
        root.path,
        join(app.path, "src/server.ts"),
        { target: "bun", compile: "server" }
      );
    });

    const targetDir = join(app.path, ".elyra/build/bun");
    expect(existsSync(join(targetDir, "client"))).toBe(true);
    expect(existsSync(join(targetDir, "public/.gitkeep"))).toBe(true);
  });

  test("compile embed removes client assets after build", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    await withCompileStub(async () => {
      await buildBunTarget(
        routes,
        app.path,
        join(app.path, ".elyra/build"),
        root.path,
        join(app.path, "src/server.ts"),
        { target: "bun", compile: "embed" }
      );
    });

    const targetDir = join(app.path, ".elyra/build/bun");
    expect(existsSync(join(targetDir, "client"))).toBe(false);
  });
});
