import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { detectLoaderFromPath, SCRIPT_FILE_FILTER } from "../server/lang-detect.ts";

/** Fingerprint server imports without importing their code into the client bundle. */
export function hmrDependencySignature(imports: Set<string>, filename: string): string | undefined {
  const routePath = resolve(filename);
  const visited = new Set<string>();
  const hash = new Bun.CryptoHasher("sha256");
  const visit = (specifier: string, importer: string): boolean => {
    // Framework/package internals are not application source dependencies.
    if (
      specifier === "furin" ||
      specifier.startsWith("furin/") ||
      specifier === "@teyik0/furin" ||
      specifier.startsWith("@teyik0/furin/")
    ) {
      return true;
    }
    const path = Bun.resolveSync(specifier, dirname(importer));
    // A helper can read route exports that are absent from the loader's AST.
    if (path === routePath) {
      return false;
    }
    hash.update(JSON.stringify([specifier, path]));
    if (
      !isAbsolute(path) ||
      path.replaceAll("\\", "/").includes("/node_modules/") ||
      visited.has(path)
    ) {
      return true;
    }
    visited.add(path);
    const source = readFileSync(path, "utf8");
    hash.update(source);
    if (SCRIPT_FILE_FILTER.test(path)) {
      const transpiler = new Bun.Transpiler({ loader: detectLoaderFromPath(path) });
      for (const dependency of transpiler.scanImports(source)) {
        if (!visit(dependency.path, path)) {
          return false;
        }
      }
    }
    return true;
  };
  try {
    for (const specifier of imports) {
      if (!visit(specifier, routePath)) {
        return;
      }
    }
    return hash.digest("hex");
  } catch {
    // An unresolved/invalid dependency must keep the conservative refresh path.
  }
}
