/** File the Vercel runtime modules read next to the Function bundle. */
export const VERCEL_DATA_FILE = "furin-vercel.json";

/** Query parameter carrying the original path into a Prerender Function. */
export const ISR_PATH_PARAM = "__furin_path";

/** Build data the Vercel runtime modules read at cold start. */
export interface VercelRuntimeData {
  appCount: number;
  /** `[cacheTagRegExpSource, semanticTags]`, most specific route first. */
  cacheTagRules: [source: string, tags: string[]][];
  /** PPR routes per mount, resumed by the chained continuation. */
  pprBuilds: { buildId: string; patterns: string[]; prefix: string }[];
  /** Shared secret Vercel sends on PPR continuations. */
  pprResumeKey: string;
  /** `[functionPath, pathRegExpSource]` of every Prerender Function alias. */
  prerenderAliases: [alias: string, source: string][];
  routeCount: number;
  /** Raw size of the Function's JavaScript, reported on cold start. */
  serverBundleBytes: number;
}
