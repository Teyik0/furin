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
      'import { defineRoute } from "@teyik0/furin";',
      'import { t } from "elysia";',
      "",
      "export const route = defineRoute()",
      '  .config({ params: t.Object({ slug: t.String() }) })',
      "  .page(() => <article>Blog post page</article>);",
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

  test("compiled Windows server paths include the executable extension", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const buildConfigs: Bun.BuildConfig[] = [];
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      const manifest = await withBuildStub(
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
      const compile = serverBuild?.compile;

      expect(compile).toBeObject();
      if (typeof compile !== "object") {
        throw new TypeError("Expected compile options");
      }
      expect(compile.outfile).toBe(join(app.path, ".furin/build/bun/server.exe"));
      expect(manifest.serverPath).toBe(".furin/build/bun/server.exe");
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }
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

  test("server builds precompile the exported Elysia app through a real capture entry", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const buildConfigs: Bun.BuildConfig[] = [];
    const userPlugin: Bun.BunPlugin = { name: "test-user-plugin", setup() {} };

    await withBuildStub(
      () =>
        buildBunTarget(
          [{ pagesDir: join(app.path, "src/pages"), prefix: "", root, routes }],
          app.path,
          join(app.path, ".furin/build"),
          join(app.path, "src/server.ts"),
          { plugins: [userPlugin], target: "bun" }
        ),
      (config) => {
        buildConfigs.push(config);
      }
    );

    const serverBuild = buildConfigs.find((config) =>
      config.entrypoints.some((entrypoint) => entrypoint.endsWith("/server.ts"))
    );
    const pluginNames = serverBuild?.plugins?.map((plugin) => plugin.name) ?? [];
    const captureEntry = join(app.path, ".furin/build/bun/_furin-app.ts");
    const captureSource = readFileSync(captureEntry, "utf8");
    const bootSource = serverBuild?.files?.[serverBuild.entrypoints[0] as string];

    expect(pluginNames).toContain("elysia-aot");
    expect(pluginNames).toContain("test-user-plugin");
    expect(pluginNames.indexOf("test-user-plugin")).toBeLessThan(pluginNames.indexOf("elysia-aot"));
    expect(existsSync(captureEntry)).toBe(true);
    expect(captureSource).toContain("export default __serverModule.default");
    expect(captureSource).not.toContain(".listen(");
    expect(captureSource).toContain("_furin-routes-0.ts");
    expect(bootSource).toContain("_furin-app.ts");
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
    const source = readFileSync(join(app.path, ".furin/build/bun/_furin-app.ts"), "utf8");
    expect(source).toContain("import.meta.dir");
    expect(source).not.toContain('with { type: "file" }');
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

  test("the default client bundle excludes Furin's evlog router import", async () => {
    const app = createCompileTmpApp();
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const metafilePath = join(app.path, "client.json");

    await buildClient(routes, {
      basePath: "",
      clientLogging: false,
      metafilePath,
      outDir: join(app.path, "client-build"),
      publicPath: "/_client/",
      rootLayout: root.path,
    });

    const metafile = JSON.parse(readFileSync(metafilePath, "utf8")) as Bun.BuildMetafile;
    expect(Object.keys(metafile.inputs).some((path) => /node_modules[/\\]evlog[/\\]/.test(path))).toBe(false);
  });

  test("client logging isolation leaves application evlog imports intact", async () => {
    const app = createCompileTmpApp();
    writeFileSync(
      join(app.path, "src/pages/index.tsx"),
      'import { log } from "evlog";\nimport { defineRoute } from "@teyik0/furin";\nimport { route as root } from "./root";\nexport const route = defineRoute().config({ layout: root, mode: "ssr" }).page(() => <main>{String(log.info)}</main>);'
    );
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const metafilePath = join(app.path, "client.json");

    await buildClient(routes, {
      basePath: "",
      clientLogging: false,
      metafilePath,
      outDir: join(app.path, "client-build"),
      publicPath: "/_client/",
      rootLayout: root.path,
    });

    const metafile = JSON.parse(readFileSync(metafilePath, "utf8")) as Bun.BuildMetafile;
    expect(Object.keys(metafile.inputs).some((path) => /node_modules[/\\]evlog[/\\]/.test(path))).toBe(true);
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
        'import { defineRoute } from "@teyik0/furin";',
        'export const route = defineRoute().config({ mode: "ssg" })',
        '  .staticParams(async () => { throw new Error("snapshot should not run"); })',
        "  .page(() => <main>Home</main>);",
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
