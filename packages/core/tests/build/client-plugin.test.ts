import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { buildClient } from "../../src/build/client.ts";
import { generateHydrateEntry } from "../../src/build/hydrate.ts";
import stripPlugin from "../../src/plugin/index.ts";
import { scanPages } from "../../src/server/router/discovery.ts";
import { createTmpApp, type TmpApp } from "../support/app-fixtures.ts";

const CORE_DIR = resolve(import.meta.dir, "../..");
const BUNDLED_MODULE_COMMENT = /^\/\/ (src\/\S+)$/gm;

const tmpApps: TmpApp[] = [];

afterEach(() => {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

/** A page whose client component renders a schema from a module shared with the server. */
function createSharedSchemaApp(schemaModule: string): TmpApp {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);
  writeFileSync(join(app.path, "src/schema.ts"), schemaModule);
  writeFileSync(
    join(app.path, "src/pages/index.tsx"),
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { schema } from "../schema";',
      'import { route as root } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: root, mode: "ssr" })',
      "  .page(() => <main>{JSON.stringify(schema)}</main>);",
    ].join("\n")
  );
  return app;
}

async function productionClientInputs(app: TmpApp): Promise<string[]> {
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
  return Object.keys(metafile.inputs);
}

/** Bundles the dev hydration entry the way Bun's dev server does with `[serve.static] plugins`. */
async function developmentClientInputs(app: TmpApp): Promise<string[]> {
  const { root, routes } = await scanPages(join(app.path, "src/pages"));
  const hydratePath = join(app.path, ".furin/_hydrate.tsx");
  mkdirSync(join(app.path, ".furin"), { recursive: true });
  writeFileSync(hydratePath, generateHydrateEntry(routes, root.path, "", false));
  const result = await Bun.build({
    entrypoints: [hydratePath],
    metafile: true,
    plugins: [stripPlugin],
    target: "browser",
  });
  return Object.keys(result.metafile?.inputs ?? {});
}

const clientInputs = [
  ["development", developmentClientInputs],
  ["production", productionClientInputs],
] as const;

/** Furin modules in a browser graph: its sources, and those bundled into each `dist` file. */
function furinModules(inputs: string[]): { modules: string[]; sources: string[] } {
  const paths = inputs.map((input) => resolve(input));
  const sources = paths
    .filter((path) => path.startsWith(join(CORE_DIR, "src", sep)))
    .map((path) => relative(CORE_DIR, path).replaceAll("\\", "/"));
  const bundled = paths
    .filter((path) => path.startsWith(join(CORE_DIR, "dist", sep)))
    // Bun repeats a module's comment above its hoisted imports.
    .flatMap((path) => [
      ...new Set(
        [...readFileSync(path, "utf8").matchAll(BUNDLED_MODULE_COMMENT)].map((match) => match[1] as string)
      ),
    ]);
  return { modules: [...sources, ...bundled], sources };
}

describe.serial("client strip plugin", () => {
  test.each(clientInputs)(
    "the %s client runs Furin's package build, each Furin module once",
    async (_mode, inputsOf) => {
      const app = createTmpApp("cli-app");
      tmpApps.push(app);
      writeFileSync(
        join(app.path, "src/pages/index.tsx"),
        [
          'import { defineRoute } from "@teyik0/furin";',
          'import { isRscSource } from "@teyik0/furin/rsc";',
          'import { useSearch } from "@teyik0/furin/search";',
          'import { route as root } from "./root";',
          "",
          "export const route = defineRoute()",
          '  .config({ layout: root, mode: "ssr" })',
          '  .page(() => <main>{String(isRscSource(useSearch("/")))}</main>);',
        ].join("\n")
      );

      const { modules, sources } = furinModules(await inputsOf(app));

      expect(modules).toContain("src/client/document.tsx");
      expect(modules).toContain("src/client/router/search/index.ts");
      expect(modules).toContain("src/rsc/shared.tsx");
      // Flight's module registry is injected by the client plugin, not imported by the client.
      expect(sources.filter((path) => path !== "src/rsc/client-references.ts")).toEqual([]);
      expect(modules.filter((path, index) => modules.indexOf(path) !== index)).toEqual([]);
    }
  );

  test("the production client compiles Furin's development code out", async () => {
    const app = createTmpApp("cli-app");
    tmpApps.push(app);

    await productionClientInputs(app);

    const clientDir = join(app.path, "client-build/client");
    const bundle = readdirSync(clientDir)
      .map((name) => readFileSync(join(clientDir, name), "utf8"))
      .join("\n");
    expect(bundle.includes("furin.router.hmr-refreshes")).toBe(false);
  });

  test.each(clientInputs)(
    "the %s client stubs elysia in a module shared with the server",
    async (_mode, inputsOf) => {
      const app = createSharedSchemaApp(
        'import { t } from "elysia";\nexport const schema = t.Object({ city: t.String() });\n'
      );

      const inputs = await inputsOf(app);

      expect(inputs.some((path) => /node_modules[/\\]elysia[/\\]/.test(path))).toBe(false);
    }
  );

  test.each(clientInputs)(
    "the %s client stubs Bun builtins in a module shared with the server",
    async (_mode, inputsOf) => {
      const app = createSharedSchemaApp(
        'import * as sqlite from "bun:sqlite";\nexport const schema = {};\nexport const open = () => new sqlite.Database();\n'
      );

      const inputs = await inputsOf(app);

      expect(inputs.some((path) => path.startsWith("bun:"))).toBe(false);
    }
  );
});
