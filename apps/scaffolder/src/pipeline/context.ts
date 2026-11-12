import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// ── Template manifest types ────────────────────────────────────────────────

export type TemplateId = "simple" | "full";

/** All valid template identifiers — single source of truth used by arg parsing and the pipeline. */
export const TEMPLATE_IDS = ["simple", "full"] as const satisfies readonly TemplateId[];
export type TemplateFileKind = "ejs" | "static";

/** File-routing style of the generated app: `furin({ style })`. */
export type RouteStyle = "nextjs" | "tanstack";

/** All valid routing styles — used by arg parsing and the style prompt. */
export const ROUTE_STYLES = ["tanstack", "nextjs"] as const satisfies readonly RouteStyle[];

export interface TemplateBackedManifestFile {
  /** Destination path relative to project root, e.g. "package.json" */
  dest: string;
  kind: TemplateFileKind;
  /** Path relative to templates/ dir, e.g. "simple/src/server.ts.ejs" */
  src: string;
  /** Only generated for this routing style; generated for both when absent. */
  style?: RouteStyle;
}

export interface PackageJsonManifestFile {
  /** Destination path relative to project root, e.g. "package.json" */
  dest: string;
  kind: "package-json";
}

export type ManifestFile = PackageJsonManifestFile | TemplateBackedManifestFile;

export interface TemplateDefinition {
  dependencies: Record<string, string>;
  description: string;
  devDependencies: Record<string, string>;
  features: string[];
  files: ManifestFile[];
  id: TemplateId;
  label: string;
}

export interface ManifestRegistry {
  $schema?: string;
  templates: TemplateDefinition[];
  version: 2;
}

// ── Generated file descriptor ──────────────────────────────────────────────

export interface TemplateBackedGeneratedFile {
  /** Rendered content for EJS files (populated in Stage 5) */
  content?: string;
  kind: TemplateFileKind;
  /** Destination path relative to targetDir, e.g. "src/pages/index.tsx" */
  relativePath: string;
  /** Absolute source path in the scaffolder's template directory */
  sourcePath: string;
}

export interface PackageJsonGeneratedFile {
  /** Rendered content populated in Stage 5 */
  content?: string;
  kind: "package-json";
  /** Destination path relative to targetDir, e.g. "package.json" */
  relativePath: string;
}

export type GeneratedFile = PackageJsonGeneratedFile | TemplateBackedGeneratedFile;

// ── EJS template variables ─────────────────────────────────────────────────

export interface EjsTemplateVars {
  features: string[];
  furinVersion: string;
  projectName: string;
  projectNameKebab: string;
  projectNamePascal: string;
  routeStyle: RouteStyle;
  /** All resolved dep versions, keyed by package name */
  versions: Record<string, string>;
}

// ── Pipeline context ───────────────────────────────────────────────────────

export interface PipelineContext {
  // Stage 4: Dependency Resolution
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  diskSpaceOk: boolean;
  features: string[];

  // Stage 3: File Design
  fileTree: GeneratedFile[];
  furinVersion: string;
  gitInitRan: boolean;

  // Cross-cutting
  install: boolean;

  // Stage 7: Refinement
  installRan: boolean;
  manifest: TemplateDefinition | null;
  // Stage 1: Analysis
  projectName: string;
  projectNameKebab: string;
  projectNamePascal: string;
  /** Stage 2: Selection */
  routeStyle: RouteStyle | null;
  targetDir: string;

  // Stage 2: Selection
  templateId: TemplateId | null;
  treePreviewLines: string[];

  // Stage 6: Validation
  validationPassed: boolean;

  // Stage 5: Code Generation
  writtenFiles: string[];
  yes: boolean;
}

export function createContext(overrides?: Partial<PipelineContext>): PipelineContext {
  const normalizedOverrides = overrides ?? {};
  return {
    dependencies: {},
    devDependencies: {},
    diskSpaceOk: false,
    features: [],
    fileTree: [],
    furinVersion: "latest",
    gitInitRan: false,
    install: true,
    installRan: false,
    manifest: null,
    projectName: "",
    projectNameKebab: "",
    projectNamePascal: "",
    routeStyle: null,
    targetDir: "",
    templateId: null,
    treePreviewLines: [],
    validationPassed: false,
    writtenFiles: [],
    yes: false,
    ...normalizedOverrides,
  };
}

// ── Template path resolution ───────────────────────────────────────────────

/**
 * Resolve the templates/ directory regardless of whether the code is running
 * from source (src/pipeline/) or from a bundled artifact (dist/).
 */
function findTemplatesDir(): string {
  const candidates = [
    resolve(import.meta.dir, "../templates"), // bundled: dist/ → package-root/templates
    resolve(import.meta.dir, "../../templates"), // dev: src/pipeline/ → package-root/templates
  ];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, "manifest.json"))) {
      return dir;
    }
  }
  throw new Error(`Cannot resolve templates directory. Tried: ${candidates.join(", ")}`);
}

export const TEMPLATES_DIR = findTemplatesDir();

export function assertPathInsideDirectory(
  rootDir: string,
  candidatePath: string,
  errorMessage: string
): void {
  const relativePath = relative(rootDir, candidatePath);
  const isParentPath = relativePath === ".." || relativePath.startsWith(`..${sep}`);
  if (relativePath === "" || !(isParentPath || isAbsolute(relativePath))) {
    return;
  }
  throw new Error(errorMessage);
}

export function resolveTemplateSrc(srcRelative: string): string {
  const sourcePath = resolve(TEMPLATES_DIR, srcRelative);
  assertPathInsideDirectory(
    TEMPLATES_DIR,
    sourcePath,
    `Template source "${srcRelative}" escapes the templates directory.`
  );
  return sourcePath;
}
