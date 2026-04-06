import type { BuildTarget } from "../config";
import type { ResolvedRoute } from "../router";

export interface BuildClientOptions {
  outDir: string;
  pagesDir?: string;
  plugins?: Bun.BunPlugin[];
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

export interface BuildManifest {
  generatedAt: string;
  pagesDir: string;
  rootDir: string;
  rootPath: string;
  routes: BuildRouteManifestEntry[];
  serverEntry: string | null;
  targets: Partial<Record<BuildTarget, TargetBuildManifest>>;
  version: 1;
}

export interface BuildAppOptions {
  compile?: "server" | "embed";
  pagesDir?: string;
  plugins?: Bun.BunPlugin[];
  rootDir?: string;
  serverEntry?: string;
  target: BuildTarget | "all";
}

export interface BuildAppResult {
  manifest: BuildManifest;
  targets: Partial<Record<BuildTarget, TargetBuildManifest>>;
}

export type BunBuildAliasConfig = Bun.BuildConfig & {
  alias?: Record<string, string>;
  outfile?: string;
  packages?: "bundle" | "external";
  write?: boolean;
};
