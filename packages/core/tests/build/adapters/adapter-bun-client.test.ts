import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  test("client-only builds do not emit an RSC manifest", async () => {
    const app = trackedTmpApp("cli-app");
    writeFileSync(
      join(app.path, "src/pages/index.tsx"),
      [
        'import { defineRoute } from "@teyik0/furin";',
        'export const route = defineRoute().config({ mode: "ssg",',
        '  staticParams: async () => { throw new Error("snapshot should not run"); },',
        "}).page(() => <main>Home</main>);",
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
