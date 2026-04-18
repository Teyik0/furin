import type { BuildTarget, StaticExportConfig } from "../config";
import type { ResolvedRoute } from "../router";

export interface BuildClientOptions {
  /**
   * Sub-path prefix for the deployment (e.g. "/furin" for GitHub Pages).
   * Passed through to the generated hydrate entry so SPA navigation uses
   * correct physical URLs. Pass "" for root deployments.
   */
  basePath: string;
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
  serverEntry: string | null;
  serverPath: string | null;
  targetDir: string;
  templatePath: string | null;
}

export type AnyTargetManifest = TargetBuildManifest | StaticTargetBuildManifest;

export interface BuildManifest {
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
