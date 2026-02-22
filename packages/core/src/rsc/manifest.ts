import type { ClientManifest, ModuleAnalysis } from "./types";

export interface BuildOutput {
  moduleIds: string[];
  path: string;
}

export function generateClientManifest(
  analyses: ModuleAnalysis[],
  outputs: BuildOutput[]
): ClientManifest {
  const manifest: ClientManifest = {};

  for (const analysis of analyses) {
    if (analysis.type !== "client") {
      continue;
    }

    const chunks = findChunksForModule(analysis.path, outputs);
    const clientExports = analysis.exports.filter((e) => e.type === "client");

    // Always use path#exportName format for consistency
    for (const exp of clientExports) {
      const key = `${analysis.path}#${exp.name}`;
      manifest[key] = {
        id: key,
        name: exp.name,
        chunks,
      };
    }
  }

  return manifest;
}

function findChunksForModule(modulePath: string, outputs: BuildOutput[]): string[] {
  for (const output of outputs) {
    if (output.moduleIds.includes(modulePath)) {
      const chunkName = output.path.split("/").pop() ?? output.path;
      return [chunkName];
    }
  }
  return [];
}

export function createManifestEntry(
  moduleId: string,
  exportName: string,
  chunks: string[]
): ClientManifest[string] {
  return {
    id: `${moduleId}#${exportName}`,
    name: exportName,
    chunks,
  };
}

export function resolveClientReference(
  id: string,
  manifest: ClientManifest
): ClientManifest[string] | undefined {
  return manifest[id];
}
