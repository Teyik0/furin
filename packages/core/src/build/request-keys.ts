import { API, SignatureKind, SymbolFlags, TypeFlags, type Type } from "typescript/unstable/async";
import type { ResolvedRoute } from "../server/router/types.ts";

/** Resolve finite requestLoader fields before PPR renders its public shell. */
export async function extractRequestLoaderKeys(paths: readonly string[]): Promise<Map<string, string[]>> {
  const keys = new Map<string, string[]>();
  if (paths.length === 0) {
    return keys;
  }
  const api = new API({ cwd: process.cwd() });
  try {
    const snapshot = await api.updateSnapshot({ openFiles: [...paths] });
    for (const path of paths) {
      const project = await snapshot.getDefaultProjectForFile(path);
      const file = await project?.program.getSourceFile(path);
      if (!project || !file) {
        throw new Error(`[furin] Could not analyze requestLoader in ${path}.`);
      }
      const checker = project.checker;
      const module = await checker.getSymbolAtLocation(file);
      const exported = module && (await checker.getMemberInModuleExports(module, "route"));
      if (!exported) {
        throw new Error(`[furin] Could not find exported route in ${path}.`);
      }
      const routeSymbol =
        exported.flags & SymbolFlags.Alias ? await checker.getAliasedSymbol(exported) : exported;
      const routeType = await checker.getTypeOfSymbol(routeSymbol);
      const loader = routeType && (await checker.getPropertyOfType(routeType, "requestLoader"));
      const loaderType = loader && (await checker.getTypeOfSymbol(loader));
      const functionType = loaderType && (await checker.getNonNullableType(loaderType));
      const signature = functionType &&
        (await checker.getSignaturesOfType(functionType, SignatureKind.Call))[0];
      const returned = signature && (await checker.getReturnTypeOfSignature(signature));
      if (!returned) {
        throw new Error(`[furin] Could not infer requestLoader return type in ${path}.`);
      }
      const resultKeys = new Set<string>();
      const collect = async (type: Type): Promise<void> => {
        if (type.flags & (TypeFlags.Any | TypeFlags.Unknown)) {
          throw new Error(`[furin] requestLoader in ${path} must return a typed object with finite keys.`);
        }
        if (type.isUnionType()) {
          for (const member of await type.getTypes()) {
            await collect(member);
          }
          return;
        }
        const symbol = await type.getSymbol();
        if (symbol?.name === "Promise" && type.isTypeReference()) {
          const [resolved] = await checker.getTypeArguments(type);
          if (resolved) {
            await collect(resolved);
            return;
          }
        }
        if (!type.isObjectType() || (await checker.getIndexInfosOfType(type)).length > 0) {
          throw new Error(`[furin] requestLoader in ${path} must return an object with finite keys.`);
        }
        for (const property of await checker.getPropertiesOfType(type)) {
          resultKeys.add(property.name);
        }
      };
      await collect(returned);
      keys.set(path, [...resultKeys].sort());
    }
    return keys;
  } finally {
    await api.close();
  }
}

export async function annotateRequestLoaderKeys(routes: readonly ResolvedRoute[]): Promise<void> {
  const paths = new Set<string>();
  for (const route of routes) {
    for (const entry of route.routeChain) {
      if (entry.requestLoader) {
        paths.add(entry.sourcePath ?? route.path);
      }
    }
  }
  const byPath = await extractRequestLoaderKeys([...paths]);
  for (const route of routes) {
    const keys = new Set<string>();
    route.requestKeysByLoader = route.routeChain.map((entry) => {
      const own = entry.requestLoader ? byPath.get(entry.sourcePath ?? route.path) ?? [] : [];
      for (const key of own) {
        keys.add(key);
      }
      return own;
    });
    route.requestKeys = [...keys].sort();
  }
}
