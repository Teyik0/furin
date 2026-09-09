import type { BuildTarget, StaticExportConfig } from "../config";
import type { ResolvedRoute } from "../server/router/types.ts";

export interface BuildClientOptions {
  /**
   * Sub-path prefix for the deployment (e.g. "/furin" for GitHub Pages).
   * Passed through to the generated hydrate entry so SPA navigation uses
   * correct physical URLs. Pass "" for root deployments.
   */
  basePath: string;
  /**
   * On-disk client dir name under outDir (default "client"). Multi-instance
   * builds pass "client-<slug>" per mounted app.
   */
  clientDirName?: string;
  /** Inject the evlog client logger into the hydrate entry. Off by default. */
  clientLogging: boolean;
  outDir: string;
  pagesDir?: string;
  plugins?: Bun.BunPlugin[];
  /**
   * Public path prefix for all emitted JS/CSS chunks.
   * Pass "/_client/" for root deployments; override for basePath deployments,
   * e.g. "/furin/_client/".
   */
  publicPath: string;
  rootLayout: string;
  /**
   * Skip furin-env.d.ts generation. Set for non-root instances in
   * multi-instance dev — the file lives at the project root and only the root
   * app owns it.
   */
  skipRouteTypes?: boolean;
}

export interface BuildRouteManifestEntry {
  hasLayout: boolean;
  hasStaticParams: boolean;
  mode: ResolvedRoute["mode"];
  pagePath: string;
  pattern: string;
  revalidate: number | null;
}

export interface TargetBuildManifest {
  buildId: string;
  clientDir: string | null;
  generatedAt: string;
  rscManifestPath?: string;
  serverEntry: string | null;
  serverPath: string | null;
  targetDir: string;
  templatePath: string | null;
}

/** Build manifest entry produced by the `package` adapter. */
export interface PackageTargetBuildManifest {
  buildId: string;
  generatedAt: string;
  prefix: string;
  targetDir: string;
}

export type AnyTargetManifest =
  | TargetBuildManifest
  | StaticTargetBuildManifest
  | PackageTargetBuildManifest;

/** One mounted app in a multi-instance build. */
export interface BuildAppSpec {
  pagesDir: string;
  /** Mount prefix (`""` or absent = root). */
  prefix?: string;
}

export interface BuildManifest {
  /** Every mounted app built into this artifact (multi-instance). */
  apps?: Array<{ pagesDir: string; prefix: string; routes: BuildRouteManifestEntry[] }>;
  generatedAt: string;
  pagesDir: string;
  rootDir: string;
  rootPath: string;
  routes: BuildRouteManifestEntry[];
  serverEntry: string | null;
  targets: Partial<Record<BuildTarget, AnyTargetManifest>>;
  version: 1;
}

export interface BuildAppOptions {
  /**
   * Explicit multi-app build (furin.config.ts `apps`). Overrides `pagesDir`
   * and server-entry auto-detection.
   */
  apps?: BuildAppSpec[];
  /** Inject the evlog client logger into the hydrate entry. Defaults to false. */
  clientLogging?: boolean;
  compile?: "server" | "embed";
  pagesDir?: string;
  plugins?: Bun.BunPlugin[];
  rootDir?: string;
  serverEntry?: string;
  /** Configuration for the `static` build target. */
  staticConfig?: StaticExportConfig;
  target: BuildTarget | "all";
}

/** Build manifest entry produced by the `static` adapter. */
export interface StaticTargetBuildManifest {
  basePath: string;
  generatedAt: string;
  outDir: string;
  renderedRoutes: string[];
  skippedRoutes: string[];
}

export interface BuildAppResult {
  manifest: BuildManifest;
  targets: Partial<Record<BuildTarget, AnyTargetManifest>>;
}

export type BunBuildAliasConfig = Bun.BuildConfig & {
  alias?: Record<string, string>;
  outfile?: string;
  packages?: "bundle" | "external";
  write?: boolean;
};
