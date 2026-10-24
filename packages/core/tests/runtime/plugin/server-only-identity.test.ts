/**
 * Integration test: a server-only module imported by a page keeps the module
 * instance the server entry already evaluated, while other local modules are
 * versioned with the page.
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { rewriteBareImports, toImportSpecifier } from "../../../src/server/dev-page-imports.ts";
import { registerDevPagePlugin } from "../../../src/server/dev-page-plugin.ts";
import { requireTmpPath, withTmpFiles } from "../../support/tmp-files";

registerDevPagePlugin();

const CORE_DIR = import.meta.dir.replace(/[\\/]tests(?:[\\/].*)?$/, "");
const TMP_DIR = join(CORE_DIR, ".tmp-tests", "server-only-identity");
mkdirSync(TMP_DIR, { recursive: true });

test("pages share server-only modules with the server entry", () =>
  withTmpFiles(
    TMP_DIR,
    {
      "helper.ts": "export const helper = {};\n",
      "page.tsx": (
        paths
      ) => `import { state } from "./${basename(requireTmpPath(paths, "state.ts"))}";
        import { helper } from "./${basename(requireTmpPath(paths, "helper.ts"))}";
        export { helper, state };
        export default function Page() {
          return <main />;
        }`,
      "state.ts": `import "@teyik0/furin/server-only";
        export const state = {};
`,
    },
    async (paths) => {
      const server = await import(requireTmpPath(paths, "state.ts"));
      const helper = await import(requireTmpPath(paths, "helper.ts"));
      const page = await import(
        `${requireTmpPath(paths, "page.tsx")}?furin-server&t=${Date.now()}`
      );

      expect(page.state).toBe(server.state);
      expect(page.helper).not.toBe(helper.helper);
    }
  ));

test("aliased imports of server-only modules keep their file identity", () => {
  const directory = mkdtempSync(join(TMP_DIR, "alias-"));
  try {
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } })
    );
    writeFileSync(join(directory, "state.ts"), 'import "@teyik0/furin/server-only";\n');
    writeFileSync(join(directory, "helper.ts"), "export const helper = {};\n");

    const rewritten = rewriteBareImports(
      'import "@/state";\nimport "@/helper";\n',
      directory,
      "ts"
    );

    expect(rewritten).toContain(
      `import ${JSON.stringify(toImportSpecifier(join(directory, "state.ts")))};`
    );
    expect(rewritten).toContain(
      `${toImportSpecifier(join(directory, "helper.ts"))}?furin-server&t=`
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
