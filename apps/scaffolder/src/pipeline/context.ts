import { resolve } from "node:path";

// ── Template manifest types ────────────────────────────────────────────────

export type TemplateId = "simple" | "full";

/** All valid template identifiers — single source of truth used by arg parsing and the pipeline. */
export const TEMPLATE_IDS = ["simple", "full"] as const satisfies readonly TemplateId[];
export type FileKind = "ejs" | "static";

export interface ManifestFile {
  /** Destination path relative to project root, e.g. "package.json" */
  dest: string;
  kind: FileKind;
  /** Path relative to templates/ dir, e.g. "simple/package.json.ejs" */
  src: string;
}

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

export interface GeneratedFile {
  /** Rendered content for EJS files (populated in Stage 5) */
  content?: string;
  kind: FileKind;
  /** Destination path relative to targetDir, e.g. "src/pages/index.tsx" */
  relativePath: string;
  /** Absolute source path in the scaffolder's template directory */
  sourcePath: string;
}

// ── EJS template variables ─────────────────────────────────────────────────

export interface EjsTemplateVars {
  features: string[];
  furinVersion: string;
  projectName: string;
  projectNameKebab: string;
  projectNamePascal: string;
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

export function createContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    projectName: "",
    projectNameKebab: "",
    projectNamePascal: "",
    targetDir: "",
    diskSpaceOk: false,
    templateId: null,
    manifest: null,
    fileTree: [],
    treePreviewLines: [],
    dependencies: {},
    devDependencies: {},
    writtenFiles: [],
    validationPassed: false,
    installRan: false,
    gitInitRan: false,
    install: true,
    yes: false,
    furinVersion: "latest",
    features: [],
    ...overrides,
  };
}

// ── Template path resolution ───────────────────────────────────────────────

/**
 * Absolute path to the templates/ directory.
 *
 * import.meta.dir = .../apps/scaffolder/src/pipeline/
 * ../.. up = .../apps/scaffolder/  (local monorepo)
 *         = .../node_modules/create-furin/  (bunx / published)
 * + templates = .../templates/
 */
export const TEMPLATES_DIR = resolve(import.meta.dir, "../../templates");

export function resolveTemplateSrc(srcRelative: string): string {
  return resolve(TEMPLATES_DIR, srcRelative);
}
