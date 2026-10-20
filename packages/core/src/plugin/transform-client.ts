import { detectLangFromPath } from "../server/lang-detect.ts";
import { pruneOrphanedCode } from "./dead-code-elimination.ts";
import { createHmrDataSignature } from "./hmr-data-signature.ts";
import { collectClientHookSignature, unusedIdentifier } from "./hmr-hook-signature.ts";
import { parseModule } from "./module-transform.ts";
import {
  analyzeRouteChains,
  assertCompleteRouteChains,
  collectDefineRouteBindings,
} from "./route-chains.ts";
import { removeChainedServerCalls, type StrippedCode } from "./strip-server-stages.ts";
import { rewriteClientModules } from "./transform-client-module.ts";
import { selectIsomorphicFunctions } from "./transform-isomorphic.ts";

const HMR_DATA_SIGNATURE = "furin.hmr.data-signature";
const HMR_SOURCE_SIGNATURE = "furin.hmr.source-signature";

interface TransformResult {
  code: string;
  removedServerCode: boolean;
}

/** Server stages and their imports share one signature across both HMR graphs. */
export function getHmrDataSignature(code: string, filename: string): string {
  const { program } = parseModule(code, filename);
  const chains = analyzeRouteChains(program, collectDefineRouteBindings(program));
  return createHmrDataSignature(code, program, chains.serverStages, filename);
}

export function transformForClient(code: string, filename: string): TransformResult {
  const lang = detectLangFromPath(filename);
  if (lang === "dts") {
    return { code, removedServerCode: false };
  }

  // Every step below reads this one AST and edits its MagicString in `code`
  // coordinates; nothing is reparsed until Bun bundles the result.
  const module = parseModule(code, filename);
  const { program, source } = module;
  const clientModules = rewriteClientModules(module, "client");
  const isomorphic = selectIsomorphicFunctions(module, "client");
  const routeBindings = collectDefineRouteBindings(program);
  assertCompleteRouteChains(program, routeBindings, filename);
  const chains = analyzeRouteChains(program, routeBindings);
  const stripped: StrippedCode = { configBindings: new Set(), retained: new Set() };
  const removedRouteCode = removeChainedServerCalls(module, routeBindings, chains, stripped);
  const removedServerCode = clientModules || isomorphic || removedRouteCode;
  if (removedServerCode) {
    pruneOrphanedCode(module, stripped.configBindings, stripped.retained);
  }
  let hookSignature =
    routeBindings.size > 0 ? collectClientHookSignature(code, program, chains.component) : null;
  if (hookSignature && typeof hookSignature === "object" && !Array.isArray(hookSignature)) {
    const createElementBinding = unusedIdentifier(program, "__furinCreateElement");
    // On the first line: an added line would shift every stack frame of the module.
    source.prepend(`import { createElement as ${createElementBinding} } from "react"; `);
    source.update(
      hookSignature.start,
      hookSignature.end,
      `(import.meta.hot ? (props) => ${createElementBinding}(${hookSignature.expression}, props) : ${hookSignature.expression})`
    );
    hookSignature = [];
  }
  if (routeBindings.size > 0 && hookSignature !== null) {
    const hmrDataSignature = createHmrDataSignature(code, program, chains.serverStages, filename);
    const signatureValue = Array.isArray(hookSignature)
      ? JSON.stringify(hookSignature)
      : 'route.component[Symbol.for("furin.hmr.hook-signature")] ?? [String(route.component)]';
    source.append(`
if (import.meta.hot && route?.component) {
  const previousDataSignature = ${JSON.stringify(hmrDataSignature)};
  const previousSourceSignature = ${JSON.stringify(Bun.hash(code).toString(16))};
  Object.defineProperty(route, Symbol.for(${JSON.stringify(HMR_SOURCE_SIGNATURE)}), {
    configurable: true,
    value: previousSourceSignature,
  });
  Object.defineProperty(route, Symbol.for(${JSON.stringify(HMR_DATA_SIGNATURE)}), {
    configurable: true,
    value: previousDataSignature,
  });
  Object.defineProperty(route.component, Symbol.for("furin.hmr.hook-signature"), {
    configurable: true,
    value: ${signatureValue},
  });
  import.meta.hot.accept((updatedModule) => {
    const updatedRoute = updatedModule?.route;
    if (updatedRoute?.component) {
      const updatedDataSignature = Reflect.get(
        updatedRoute,
        Symbol.for(${JSON.stringify(HMR_DATA_SIGNATURE)})
      );
      // An unchanged source can be re-evaluated by Bun after an import edit
      // without rerunning this transform. Its embedded dependency hash is stale.
      const dataChanged =
        previousDataSignature.startsWith("external:") ||
        typeof updatedDataSignature !== "string" ||
        updatedDataSignature.startsWith("external:") ||
        (updatedDataSignature.startsWith("imports:") &&
          Reflect.get(updatedRoute, Symbol.for(${JSON.stringify(HMR_SOURCE_SIGNATURE)})) === previousSourceSignature) ||
        updatedDataSignature !== previousDataSignature;
      window.__FURIN_HMR_UPDATE__?.(${JSON.stringify(filename)}, updatedRoute.component, dataChanged);
    }
  });
}
`);
  }

  return { code: source.toString(), removedServerCode };
}
