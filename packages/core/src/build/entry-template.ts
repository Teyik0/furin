import { resolve } from "node:path";

const INTERNAL_MODULE_PATH = resolve(import.meta.dir, "../internal.ts").replace(/\\/g, "/");
const RUNTIME_ENV_MODULE_PATH = resolve(import.meta.dir, "../runtime-env.ts").replace(/\\/g, "/");

export interface EntryTemplateOptions {
  buildId?: string;
  headerComment: string;
  rootPath: string;
  routes: Array<{ mode: "ssr" | "ssg" | "isr"; path: string; pattern: string }>;
  serverEntry: string;
  extraImports?: string[];
  extraContext?: string[];
}

export function buildEntrySource(options: EntryTemplateOptions): string {
  const {
    buildId,
    headerComment,
    rootPath,
    routes,
    serverEntry,
    extraImports = [],
    extraContext = [],
  } = options;

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
