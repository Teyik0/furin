import { dirname } from "node:path";
import { type Exports, parse } from "cjs-module-lexer";
import MagicString from "magic-string";
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

const COMMONJS_EXTENSION = /\.c[jt]s$/;
const ESM_EXTENSION = /\.m[jt]s$/;
const ESM_EXPORTS = new Set([
  "ExportAllDeclaration",
  "ExportDefaultDeclaration",
  "ExportNamedDeclaration",
]);

/** Mirrors Bun: ESM export syntax wins over any reference to module or exports. */
function isCommonJsModule(source: string, path: string): boolean {
  if (COMMONJS_EXTENSION.test(path)) {
    return true;
  }
  if (ESM_EXTENSION.test(path)) {
    return false;
  }
  const { program } = parseSource(source, detectLangFromPath(path));
  return !program.body.some((statement) => ESM_EXPORTS.has(statement.type));
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
        const source = transformIsomorphicFunctions(
          await Bun.file(sourcePath).text(),
          sourcePath,
          "server"
        ).code;
        // Generated bindings share the module scope with the source.
        let prefix = "__furin";
        while (source.includes(prefix)) {
          prefix += "_";
        }
        return {
          // Keep registration with the implementation: sideEffects: false can
          // let the bundler bypass a module that only reexports its bindings.
          contents: isCommonJsModule(source, sourcePath)
            ? source
            : `${source}
import * as ${prefix}Implementation from ${JSON.stringify(path)};
import { registerClientModule as ${prefix}RegisterClientModule } from ${JSON.stringify(CLIENT_REFERENCE_RUNTIME_PATH)};
${prefix}RegisterClientModule(${JSON.stringify(clientModuleId(sourcePath))}, ${prefix}Implementation);`,
          loader: detectLoaderFromPath(sourcePath),
          resolveDir: dirname(sourcePath),
        };
      });
      build.onLoad({ filter: SCRIPTS }, async ({ path }) => {
        const source = await Bun.file(path).text();
        if (!isClientModule(source, path)) {
          return;
        }
        // CommonJS needs the completed interop namespace from the wrapper.
        // Name its exports: Bun bypasses a CommonJS `export *` wrapper.
        const commonJs = isCommonJsModule(source, path);
        const names = commonJs
          ? await exportedNames(source, path, new Set())
          : new Bun.Transpiler({ loader: detectLoaderFromPath(path) })
              .scan(source)
              .exports.filter((name) => name === "default");
        return {
          contents: `${
            commonJs
              ? `import * as implementation from ${JSON.stringify(path + IMPLEMENTATION)};
import { registerClientModule } from ${JSON.stringify(CLIENT_REFERENCE_RUNTIME_PATH)};
registerClientModule(${JSON.stringify(clientModuleId(path))}, implementation);`
              : ""
          }
export * from ${JSON.stringify(path + IMPLEMENTATION)};
${names.length > 0 ? `export { ${names.map((name) => JSON.stringify(name)).join(", ")} } from ${JSON.stringify(path + IMPLEMENTATION)};` : ""}`,
          loader: "js",
          resolveDir: dirname(path),
        };
      });
    },
  };
}

/** cjs-module-lexer reads plain scripts; Bun also accepts imports in CommonJS. */
function commonJsExports(source: string, path: string): Exports {
  const script = new Bun.Transpiler({ loader: detectLoaderFromPath(path) }).transformSync(source);
  const withoutImports = new MagicString(script);
  for (const statement of parseSource(script, "js").program.body) {
    if (statement.type === "ImportDeclaration") {
      withoutImports.remove(statement.start, statement.end);
    }
  }
  return parse(withoutImports.toString());
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
  const reexports: string[] = [];
  if (isCommonJsModule(source, path)) {
    names.add("default");
    const commonJs = commonJsExports(source, path);
    for (const name of commonJs.exports) {
      if (name !== "__esModule") {
        names.add(name);
      }
    }
    reexports.push(...commonJs.reexports);
  }
  for (const statement of parseSource(source, detectLangFromPath(path)).program.body) {
    if (
      statement.type === "ExportAllDeclaration" &&
      !statement.exported &&
      statement.exportKind !== "type"
    ) {
      reexports.push(String(statement.source.value));
    }
  }
  for (const specifier of reexports) {
    const dependency = Bun.resolveSync(specifier, dirname(path));
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
