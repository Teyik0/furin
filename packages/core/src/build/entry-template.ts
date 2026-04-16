import { dirname } from "node:path";

// import.meta.resolve() runs at runtime (not inlined at bundle time), resolves
// through package exports, and is the Web-standard API. The "bun" condition
// on "." resolves to src/furin.ts, so dirname gives us the src/ dir.
const _pkgSrcDir = dirname(new URL(import.meta.resolve("@teyik0/furin")).pathname);
const INTERNAL_MODULE_PATH = `${_pkgSrcDir}/internal.ts`;
const RUNTIME_ENV_MODULE_PATH = `${_pkgSrcDir}/runtime-env.ts`;

export interface EntryTemplateOptions {
  buildId?: string;
  extraContext?: string[];
  extraImports?: string[];
  headerComment: string;
  rootPath: string;
  routes: Array<{ mode: "ssr" | "ssg" | "isr"; path: string; pattern: string }>;
  serverEntry: string;
}

export function buildEntrySource(options: EntryTemplateOptions): string {
  const { buildId, headerComment, rootPath, routes, serverEntry } = options;
  let { extraImports, extraContext } = options;
  if (extraImports === undefined) {
    extraImports = [];
  }
  if (extraContext === undefined) {
    extraContext = [];
  }

  const allModulePaths = [rootPath, ...routes.map((r) => r.path)];
  const moduleImports: string[] = [];
  const moduleEntries: string[] = [];

  for (let i = 0; i < allModulePaths.length; i++) {
    const absPath = (allModulePaths[i] as string).replace(/\\/g, "/");
    const varName = `_mod${i}`;
    moduleImports.push(`import * as ${varName} from ${JSON.stringify(absPath)};`);
    moduleEntries.push(`  ${JSON.stringify(absPath)}: ${varName},`);
  }

  const routeEntries = routes.map(
    (r) =>
      `    { pattern: ${JSON.stringify(r.pattern)}, path: ${JSON.stringify(r.path.replace(/\\/g, "/"))}, mode: ${JSON.stringify(r.mode)} },`
  );

  const lines = [
    headerComment,
    `import { __setCompileContext } from ${JSON.stringify(INTERNAL_MODULE_PATH)};`,
    `import { __setDevMode } from ${JSON.stringify(RUNTIME_ENV_MODULE_PATH)};`,
    ...moduleImports,
    ...(extraImports.length > 0 ? ["", ...extraImports] : []),
    "",
    "// Force production mode — Bun may inline process.env.NODE_ENV at bundle time.",
    "__setDevMode(false);",
    'process.env.NODE_ENV = "production";',
    "",
    "__setCompileContext({",
    `  buildId: ${JSON.stringify(buildId ?? "")},`,
    `  rootPath: ${JSON.stringify(rootPath.replace(/\\/g, "/"))},`,
    "  modules: {",
    ...moduleEntries,
    "  },",
    "  routes: [",
    ...routeEntries,
    "  ],",
    ...extraContext,
    "});",
    "",
    `await import(${JSON.stringify(serverEntry.replace(/\\/g, "/"))});`,
    "",
  ];

  return lines.join("\n");
}
