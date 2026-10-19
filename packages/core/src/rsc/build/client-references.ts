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
const REFERENCE_NAMESPACE = "furin-client-reference";
const REFERENCE_MODULE = /^furin-client-reference:/;

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

/**
 * Registers each client module's exports for SSR's Flight client: the exports in
 * `references` (the RSC graph's), or the whole namespace without a graph.
 */
function clientRegistration(
  sourcePath: string,
  path: string,
  prefix: string,
  references: readonly ClientReference[] | undefined
): string {
  const id = clientModuleId(sourcePath);
  const register = `import { registerClientModule as ${prefix}RegisterClientModule } from ${JSON.stringify(CLIENT_REFERENCE_RUNTIME_PATH)};`;
  if (references === undefined) {
    return `import * as ${prefix}Implementation from ${JSON.stringify(path)};
${register}
${prefix}RegisterClientModule(${JSON.stringify(id)}, ${prefix}Implementation);`;
  }
  const names = references.filter((reference) => reference.id === id).map(({ name }) => name);
  if (names.length === 0) {
    return "";
  }
  // Getters keep the bindings live: a module cycle can register them uninitialized.
  return `import { ${names.map((name, index) => `${JSON.stringify(name)} as ${prefix}${index}`).join(", ")} } from ${JSON.stringify(path)};
${register}
${prefix}RegisterClientModule(${JSON.stringify(id)}, { ${names.map((name, index) => `get ${JSON.stringify(name)}() { return ${prefix}${index}; }`).join(", ")} });`;
}

export function clientReferencesPlugin(
  references: readonly ClientReference[] | undefined
): Bun.BunPlugin {
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
${clientRegistration(sourcePath, path, prefix, references)}`,
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

function referenceModule({ id, name }: ClientReference): string {
  return `${REFERENCE_NAMESPACE}:${id}#${encodeURIComponent(name)}`;
}

/** One module per reference: the RSC bundle drops those no server code uses. */
export function rscClientReferencesPlugin(references: ClientReference[]): Bun.BunPlugin {
  return {
    name: "furin-rsc-client-boundaries",
    setup(build) {
      flightLoaderPlugin().setup(build);
      build.onResolve({ filter: REFERENCE_MODULE }, ({ path }) => ({
        namespace: REFERENCE_NAMESPACE,
        path: path.slice(REFERENCE_NAMESPACE.length + 1),
      }));
      build.onLoad({ filter: /.*/, namespace: REFERENCE_NAMESPACE }, ({ path }) => {
        const separator = path.indexOf("#");
        return {
          contents: `import { createClientReference } from ${JSON.stringify(CLIENT_REFERENCE_RUNTIME_PATH)};
export default /* @__PURE__ */ createClientReference(${JSON.stringify(path.slice(0, separator))}, ${JSON.stringify(decodeURIComponent(path.slice(separator + 1)))});`,
          loader: "js",
        };
      });
      build.onLoad({ filter: SCRIPTS }, async ({ path }) => {
        const source = await Bun.file(path).text();
        if (!isClientModule(source, path)) {
          return;
        }
        const id = clientModuleId(path);
        const moduleReferences = (await exportedNames(source, path, new Set())).map((name) => ({
          chunks: [],
          id,
          name,
        }));
        references.push(...moduleReferences);
        return {
          contents: moduleReferences
            .map(
              (reference) =>
                `export { default as ${reference.name === "default" ? "default" : JSON.stringify(reference.name)} } from ${JSON.stringify(referenceModule(reference))};`
            )
            .join("\n"),
          loader: "js",
        };
      });
    },
  };
}

/** The references the RSC bundle kept, like Vite RSC's rendered exports. */
export function referencedClientExports(
  references: readonly ClientReference[],
  metafile: Bun.BuildMetafile
): ClientReference[] {
  const bundled = new Set(
    Object.values(metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, input]) => input.bytesInOutput > 0)
        .map(([path]) => path)
    )
  );
  return references.filter((reference) => bundled.has(referenceModule(reference)));
}
