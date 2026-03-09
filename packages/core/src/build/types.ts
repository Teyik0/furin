import type { BuildTarget } from "../config";
import type { ResolvedRoute } from "../router";

export interface BuildClientOptions {
  outDir: string;
  pagesDir?: string;
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
  clientDir: string;
  generatedAt: string;
  manifestPath: string;
  routeTypesPath: string;
  serverEntry: string | null;
  serverPath: string | null;
  target: BuildTarget;
  targetDir: string;
  templatePath: string;
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
  compile?: boolean;
  minify?: boolean;
  outDir?: string;
  pagesDir?: string;
  rootDir?: string;
  serverEntry?: string;
  sourcemap?: boolean;
  target: BuildTarget | "all";
}

export interface BuildAppResult {
  manifest: BuildManifest;
  targets: Partial<Record<BuildTarget, TargetBuildManifest>>;
}

export interface TypegenOptions {
  outDir?: string;
  pagesDir?: string;
  rootDir?: string;
}

export type BunBuildAliasConfig = Bun.BuildConfig & {
  alias?: Record<string, string>;
  outfile?: string;
  packages?: "bundle" | "external";
  write?: boolean;
};
