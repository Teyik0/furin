import { dirname } from "node:path";
import { transformIsomorphicFunctions } from "../../plugin/transform-isomorphic.ts";
import { detectLangFromPath, detectLoaderFromPath } from "../../server/lang-detect.ts";
import { parseSource } from "../../shared/parser.ts";
import { flightLoaderPlugin } from "./flight-loader.ts";
import type { ClientReference } from "./index.ts";
import { CLIENT_REFERENCE_RUNTIME_PATH } from "./paths.ts";

const IMPLEMENTATION = "?furin-client-implementation";
const SCRIPTS = /\.[cm]?[jt]sx?$/;

export function clientModuleId(path: string): string {
  return `furin:${Bun.hash(path.replaceAll("\\", "/")).toString(16)}`;
}

export function isClientModule(source: string, path: string): boolean {
  if (!source.includes("use client")) {
    return false;
  }
  const { program } = parseSource(source, detectLangFromPath(path));
  for (const statement of program.body) {
    if (statement.type !== "ExpressionStatement" || !statement.directive) {
      break;
    }
    if (statement.directive === "use client") {
      return true;
    }
  }
  return false;
}

export function clientReferencesPlugin(): Bun.BunPlugin {
  return {
    name: "furin-client-references",
    setup(build) {
      flightLoaderPlugin().setup(build);
      build.onResolve({ filter: /\?furin-client-implementation$/ }, ({ path }) => ({
        namespace: "furin-client-implementation",
        path,
      }));
      build.onLoad({ filter: /.*/, namespace: "furin-client-implementation" }, async ({ path }) => {
        const sourcePath = path.slice(0, -IMPLEMENTATION.length);
        return {
          contents: transformIsomorphicFunctions(
            await Bun.file(sourcePath).text(),
            sourcePath,
            "server"
          ).code,
          loader: detectLoaderFromPath(sourcePath),
          resolveDir: dirname(sourcePath),
        };
      });
      build.onLoad({ filter: SCRIPTS }, async ({ path }) => {
        const source = await Bun.file(path).text();
        if (!isClientModule(source, path)) {
          return;
        }
        const names = new Bun.Transpiler({ loader: detectLoaderFromPath(path) }).scan(
          source
        ).exports;
        return {
          contents: `import * as implementation from ${JSON.stringify(path + IMPLEMENTATION)};
import { registerClientModule } from ${JSON.stringify(CLIENT_REFERENCE_RUNTIME_PATH)};
registerClientModule(${JSON.stringify(clientModuleId(path))}, implementation);
export * from ${JSON.stringify(path + IMPLEMENTATION)};
${names.includes("default") ? `export { default } from ${JSON.stringify(path + IMPLEMENTATION)};` : ""}`,
          loader: "js",
          resolveDir: dirname(path),
        };
      });
    },
  };
}

async function exportedNames(
  source: string,
  path: string,
  visited: Set<string>
): Promise<string[]> {
  if (visited.has(path)) {
    return [];
  }
  visited.add(path);
  const names = new Set(
    new Bun.Transpiler({ loader: detectLoaderFromPath(path) })
      .scan(source)
      .exports.filter((name) => name !== "*")
  );
  for (const statement of parseSource(source, detectLangFromPath(path)).program.body) {
    if (
      statement.type !== "ExportAllDeclaration" ||
      statement.exported ||
      statement.exportKind === "type"
    ) {
      continue;
    }
    const dependency = Bun.resolveSync(String(statement.source.value), dirname(path));
    const exported = await exportedNames(await Bun.file(dependency).text(), dependency, visited);
    for (const name of exported) {
      if (name !== "default") {
        names.add(name);
      }
    }
  }
  return [...names];
}

export function rscClientReferencesPlugin(references: ClientReference[]): Bun.BunPlugin {
  return {
    name: "furin-rsc-client-boundaries",
    setup(build) {
      flightLoaderPlugin().setup(build);
      build.onLoad({ filter: SCRIPTS }, async ({ path }) => {
        const source = await Bun.file(path).text();
        if (!isClientModule(source, path)) {
          return;
        }
        const id = clientModuleId(path);
        const names = await exportedNames(source, path, new Set());
        references.push(...names.map((name) => ({ chunks: [], id, name })));
        return {
          contents: `import { createClientReference } from ${JSON.stringify(CLIENT_REFERENCE_RUNTIME_PATH)};\n${names.map((name, index) => `const reference${index} = createClientReference(${JSON.stringify(id)}, ${JSON.stringify(name)}); export { reference${index} as ${name === "default" ? "default" : JSON.stringify(name)} };`).join("\n")}`,
          loader: "js",
        };
      });
    },
  };
}
