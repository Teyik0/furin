import { detectClientFeatures } from "./detect";
import type { ModuleAnalysis } from "./types";

const CLIENT_SUFFIX = ".client.tsx";
const SERVER_SUFFIX = ".server.tsx";

export async function analyzeModule(path: string): Promise<ModuleAnalysis> {
  const code = await Bun.file(path).text();

  if (path.endsWith(CLIENT_SUFFIX)) {
    return {
      path,
      type: "client",
      exports: [],
      clientFeatures: [],
    };
  }

  if (path.endsWith(SERVER_SUFFIX)) {
    return {
      path,
      type: "server",
      exports: [],
      clientFeatures: [],
    };
  }

  const detection = detectClientFeatures(code);

  const exports = extractExports(code, detection.features);

  return {
    path,
    type: detection.isClient ? "client" : "server",
    exports,
    clientFeatures: detection.features,
  };
}

function extractExports(
  code: string,
  clientFeatures: string[]
): { name: string; type: "server" | "client" }[] {
  const exports: { name: string; type: "server" | "client" }[] = [];

  const exportFunctionPattern =
    /export\s+(?:async\s+)?function\s+([A-Z][a-zA-Z0-9]*)/g;
  let match: RegExpExecArray | null;
  while ((match = exportFunctionPattern.exec(code)) !== null) {
    exports.push({
      name: match[1] ?? "",
      type: clientFeatures.length > 0 ? "client" : "server",
    });
  }

  const exportConstPattern = /export\s+const\s+([A-Z][a-zA-Z0-9]*)\s*=/g;
  while ((match = exportConstPattern.exec(code)) !== null) {
    exports.push({
      name: match[1] ?? "",
      type: clientFeatures.length > 0 ? "client" : "server",
    });
  }

  return exports;
}

export async function analyzeAllPages(
  routes: Array<{ pattern: string; pagePath?: string }>
): Promise<Map<string, ModuleAnalysis>> {
  const analyses = new Map<string, ModuleAnalysis>();

  for (const route of routes) {
    if (!route.pagePath) continue;

    const exists = await Bun.file(route.pagePath).exists();
    if (!exists) continue;

    const analysis = await analyzeModule(route.pagePath);
    analyses.set(route.pagePath, analysis);
  }

  return analyses;
}
