import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildClient } from "../../src/build/client.ts";
import stripPlugin from "../../src/plugin/index.ts";
import { scanPages } from "../../src/server/router/discovery.ts";
import { createTmpApp, type TmpApp } from "../support/app-fixtures.ts";

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

/** Bundles one page the way Bun's dev server does with `[serve.static] plugins`. */
async function developmentClientInputs(app: TmpApp): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: [join(app.path, "src/pages/index.tsx")],
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

describe.serial("client strip plugin", () => {
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
