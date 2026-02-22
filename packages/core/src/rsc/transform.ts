import type { ClientReference, ModuleAnalysis } from "./types";
import { CLIENT_REFERENCE_SYMBOL } from "./types";

const IMPORT_PATTERN = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+["']([^"']+)["']/g;
const LOADER_PATTERN = /\.loader\s*=\s*async/;
const CLIENT_IMPORT_SUFFIX = ".client";

export function createClientReference(id: string, name: string, chunks: string[]): ClientReference {
  return {
    $$typeof: CLIENT_REFERENCE_SYMBOL,
    $$id: id,
    $$name: name,
    $$bundles: chunks,
  };
}

export function transformServerComponent(
  code: string,
  _analysis: ModuleAnalysis,
  clientReferences: Map<string, ClientReference>
): string {
  const lines = code.split("\n");
  const processedLines: string[] = [];
  const usedRefs = new Set<string>();

  for (const line of lines) {
    let transformedLine = line;
    let importMatch: RegExpExecArray | null;
    IMPORT_PATTERN.lastIndex = 0;

    while ((importMatch = IMPORT_PATTERN.exec(line)) !== null) {
      const importPath = importMatch[3] ?? "";

      if (importPath.endsWith(CLIENT_IMPORT_SUFFIX) && clientReferences.has(importPath)) {
        transformedLine = transformedLine.replace(importMatch[0], "");
        usedRefs.add(importPath);
      }
    }
    processedLines.push(transformedLine);
  }

  const referenceDeclarations: string[] = [];
  for (const refPath of usedRefs) {
    const ref = clientReferences.get(refPath);
    if (ref) {
      referenceDeclarations.push(
        `const ${ref.$$name} = createClientReference("${ref.$$id}", "${ref.$$name}", ${JSON.stringify(ref.$$bundles)});`
      );
    }
  }

  let result = processedLines.join("\n");

  if (referenceDeclarations.length > 0) {
    const importCode = `import { createClientReference } from "elysion/rsc";\n`;
    const refCode = `${referenceDeclarations.join("\n")}\n`;
    result = importCode + refCode + result;
  }

  return result;
}

export function transformClientComponent(code: string, _analysis: ModuleAnalysis): string {
  const lines = code.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    if (LOADER_PATTERN.test(line)) {
      continue;
    }

    if (line.includes(".loader") && line.includes("=")) {
      continue;
    }

    processedLines.push(line);
  }

  let result = processedLines.join("\n");

  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}
