import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildClient } from "../../../src/build/client.ts";
import { ssgRouteCache } from "../../../src/server/cache/ssg.ts";
import { __resetTemplateState } from "../../../src/server/render/template.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { createTmpApp, type TmpApp } from "../../support/app-fixtures.ts";
import { withBuildStub } from "../../support/with-build-stub.ts";

const { buildBunTarget } = await import("../../../src/adapter/bun.ts");

const tmpApps: TmpApp[] = [];

function trackedTmpApp(fixtureName: string): TmpApp {
  const app = createTmpApp(fixtureName);
  tmpApps.push(app);
  return app;
}

function createCompileTmpApp(): TmpApp {
  const app = trackedTmpApp("cli-app");
  writeFileSync(
    join(app.path, "src/pages/blog/[slug].tsx"),
    [
      'import { route as rootRoute } from "../root";',
      "",
      "export default rootRoute.page({",
      "  component: () => <article>Blog post page</article>,",
      "});",
    ].join("\n"),
  );
  return app;
}

afterEach(() => {
  ssgRouteCache().clear();
  __resetTemplateState();
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe.serial("buildBunTarget Bun branches", () => {
  test("rejects server compilation without a server entry", async () => {
    const app = trackedTmpApp("cli-app");

    await expect(
      buildBunTarget(
        [
          {
            pagesDir: join(app.path, "src/pages"),
            prefix: "",
            root: {
              path: join(app.path, "src/pages/root.tsx"),
              route: { __type: "FURIN_ROUTE" },
            },
            routes: [],
          },
        ],
        app.path,
        join(app.path, ".furin/build"),
        null,
        { compile: "server", target: "bun" },
      ),
    ).rejects.toThrow("server entry");
  });

  async function expectCompileAssets(
    compile: "embed" | "server",
    keepsClientAssets: boolean,
  ): Promise<void> {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    await withBuildStub(() =>
      buildBunTarget(
        [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
        app.path,
        join(app.path, ".furin/build"),
        join(app.path, "src/server.ts"),
        { compile, target: "bun" },
      ),
    );

    expect(existsSync(join(app.path, ".furin/build/bun/client"))).toBe(keepsClientAssets);
    if (compile === "server") {
      expect(existsSync(join(app.path, ".furin/build/bun/public/.gitkeep"))).toBe(true);
    }
  }

  test("compile server keeps client assets", async () => {
    await expectCompileAssets("server", true);
  });

  test("compile embed removes client assets", async () => {
    await expectCompileAssets("embed", false);
  });

  test("compiled server builds use split ESM bytecode", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const buildConfigs: Bun.BuildConfig[] = [];

    await withBuildStub(
      () =>
        buildBunTarget(
          [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
          app.path,
          join(app.path, ".furin/build"),
          join(app.path, "src/server.ts"),
          { compile: "server", target: "bun" }
        ),
      (config) => {
        buildConfigs.push(config);
      }
    );

    const serverBuild = buildConfigs.find((config) => config.compile !== undefined);
    expect(serverBuild?.bytecode).toBe(true);
    expect(serverBuild?.format).toBe("esm");
    expect(serverBuild?.splitting).toBe(true);
    expect(serverBuild?.target).toBe("bun");
  });

  test("embed compilation uses Bun asset directories and an in-memory server entry", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const buildConfigs: Bun.BuildConfig[] = [];

    await withBuildStub(
      () =>
        buildBunTarget(
          [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
          app.path,
          join(app.path, ".furin/build"),
          join(app.path, "src/server.ts"),
          { compile: "embed", target: "bun" }
        ),
      (config) => {
        buildConfigs.push(config);
      }
    );

    const serverBuild = buildConfigs.find((config) => config.compile !== undefined);
    const compile = serverBuild?.compile;
    expect(compile).toBeObject();
    if (typeof compile !== "object") {
      throw new TypeError("Expected compile options");
    }
    expect(compile.assets?.map((path) => path.split("/").at(-1))).toEqual(["client", "public"]);
    const entrypoint = serverBuild?.entrypoints[0];
    expect(entrypoint).toEndWith("_compile-entry.ts");
    const source = serverBuild?.files?.[entrypoint as string];
    expect(source).toBeString();
    expect(source as string).toContain("import.meta.dir");
    expect(source as string).not.toContain('with { type: "file" }');
    expect(existsSync(entrypoint as string)).toBe(false);
  });

  test("client builds enable Bun's native React Compiler by default", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const buildConfigs: Bun.BuildConfig[] = [];

    await withBuildStub(
      () =>
        buildBunTarget(
          [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
          app.path,
          join(app.path, ".furin/build"),
          join(app.path, "src/server.ts"),
          { target: "bun" }
        ),
      (config) => {
        buildConfigs.push(config);
      }
    );

    const clientBuild = buildConfigs.find((config) => config.target === "browser");
    expect(clientBuild?.reactCompiler).toBe(true);
    expect(clientBuild?.reactCompilerOutputMode).toBe("client");
  });

  test("client builds allow Bun's native React Compiler to be disabled", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const buildConfigs: Bun.BuildConfig[] = [];

    await withBuildStub(
      () =>
        buildBunTarget(
          [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
          app.path,
          join(app.path, ".furin/build"),
          join(app.path, "src/server.ts"),
          { reactCompiler: false, target: "bun" }
        ),
      (config) => {
        buildConfigs.push(config);
      }
    );

    const clientBuild = buildConfigs.find((config) => config.target === "browser");
    expect(clientBuild?.reactCompiler).toBe(false);
  });

  test("client builds pass explicit barrel optimizations to Bun", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const buildConfigs: Bun.BuildConfig[] = [];

    await withBuildStub(
      () =>
        buildBunTarget(
          [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
          app.path,
          join(app.path, ".furin/build"),
          join(app.path, "src/server.ts"),
          { optimizeImports: ["example-library"], target: "bun" }
        ),
      (config) => {
        buildConfigs.push(config);
      }
    );

    const clientBuild = buildConfigs.find((config) => config.target === "browser");
    expect(clientBuild?.optimizeImports).toEqual(["example-library"]);
  });

  test("client builds provide the generated hydration entry from memory", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const buildConfigs: Bun.BuildConfig[] = [];

    await withBuildStub(
      () =>
        buildBunTarget(
          [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
          app.path,
          join(app.path, ".furin/build"),
          join(app.path, "src/server.ts"),
          { target: "bun" }
        ),
      (config) => {
        buildConfigs.push(config);
      }
    );

    const clientBuild = buildConfigs.find((config) => config.target === "browser");
    const entrypoint = clientBuild?.entrypoints[0];
    expect(entrypoint).toEndWith("_hydrate.tsx");
    expect(clientBuild?.files?.[entrypoint as string]).toContain("hydrateRoot");
    expect(existsSync(entrypoint as string)).toBe(false);
  });

  test("virtual hydration entries still resolve page imports through user plugins", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const resolvedPages: string[] = [];
    const plugin: Bun.BunPlugin = {
      name: "test-user-plugin",
      setup(build) {
        build.onResolve({ filter: /[/\\]pages[/\\].*\.tsx$/ }, ({ path }) => {
          resolvedPages.push(path);
        });
      },
    };

    await buildClient(routes, {
      basePath: "",
      clientLogging: false,
      outDir: join(app.path, ".furin/build/plugin-check"),
      plugins: [plugin],
      publicPath: "/_client/",
      rootLayout: root.path,
    });

    expect(resolvedPages.length).toBeGreaterThan(0);
  });

  test("client analysis writes Bun's complete build metafile", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const metafilePath = join(app.path, ".furin/build/analysis/client.json");

    await buildClient(routes, {
      basePath: "",
      clientLogging: false,
      metafilePath,
      outDir: join(app.path, ".furin/build/analyzed-client"),
      publicPath: "/_client/",
      rootLayout: root.path,
    });

    const metafile = JSON.parse(readFileSync(metafilePath, "utf8")) as Bun.BuildMetafile;
    expect(Object.keys(metafile.inputs).length).toBeGreaterThan(0);
    expect(Object.keys(metafile.outputs).length).toBeGreaterThan(0);
  });

  test("Bun target analysis emits its client metafile outside served assets", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const buildRoot = join(app.path, ".furin/build");

    await withBuildStub(() =>
      buildBunTarget(
        [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
        app.path,
        buildRoot,
        null,
        { analyze: true, target: "bun" },
      ),
    );

    expect(existsSync(join(buildRoot, "analysis/bun-client.json"))).toBe(true);
    expect(existsSync(join(buildRoot, "bun/client/metafile.json"))).toBe(false);
  });

  test("client-only builds do not emit an RSC manifest", async () => {
    const app = trackedTmpApp("cli-app");
    writeFileSync(
      join(app.path, "src/pages/index.tsx"),
      [
        'import { createRoute } from "@teyik0/furin/client";',
        'const route = createRoute({ mode: "ssg" });',
        "export default route.page({",
        "  component: () => <main>Home</main>,",
        '  staticParams: async () => { throw new Error("snapshot should not run"); },',
        "});",
      ].join("\n"),
    );
    const { root, routes } = await scanPages(join(app.path, "src/pages"));

    const manifest = await withBuildStub(() =>
      buildBunTarget(
        [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
        app.path,
        join(app.path, ".furin/build"),
        null,
        { target: "bun" },
      ),
    );

    expect(manifest.rscManifestPath).toBeUndefined();
  });
});
