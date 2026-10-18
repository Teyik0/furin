import type { AdapterCapabilities } from "../server/internal.ts";

export type { AdapterCapabilities } from "../server/internal.ts";

/** A route of a mounted app, described as data. */
export interface AdapterRoute {
  /** Document render mode after layout inheritance. */
  mode: "ssr" | "ssg" | "isr";
  pattern: string;
  /** Public shell cached by the platform, private request loaders resumed per request. */
  ppr: boolean;
  /**
   * Query keys the route chain declares, or `null` when its query schema
   * cannot be enumerated. Platforms may key cached documents on them.
   */
  queryKeys: string[] | null;
  /** ISR revalidation window in seconds, `undefined` for SSG and SSR. */
  revalidate: number | undefined;
  tags: string[];
}

/** A URL whose public document is known at build time. */
export interface AdapterPrerender {
  /** Unprefixed path inside the mounted app. */
  path: string;
  pattern: string;
}

/** One mounted Furin app of the build. */
export interface AdapterApp {
  buildId: string;
  /** Built browser assets (content-hashed chunks and `index.html`). */
  clientDir: string;
  /** Full mount prefix, `""` for root. */
  prefix: string;
  /** Known SSG/ISR URLs, enumerated by the production bundle. */
  prerenders: AdapterPrerender[];
  routes: AdapterRoute[];
}

/** The production server bundle built from the adapter's runtime module. */
export interface AdapterServerBundle {
  /** Directory holding the bundle, its chunks and `server-codec.js`. */
  dir: string;
  /** Output of the adapter's runtime module, relative to `dir`. */
  entry: string;
  /** Every emitted JavaScript file, relative to `dir`. */
  files: string[];
}

/** What the framework built; the adapter turns it into a deployable layout. */
export interface AdapterBuildOutput {
  apps: AdapterApp[];
  /** Build ID of the root-mounted app (else the first app). */
  buildId: string;
  /** `.furin/build` — adapters write private build artifacts below it. */
  buildRoot: string;
  /** Project `public/` directory, if any. */
  publicDir: string | undefined;
  rootDir: string;
  server: AdapterServerBundle;
  /** Whether the build emits server source maps (kept outside deployable output). */
  serverSourceMaps: boolean;
}

/** Minimal manifest entry an adapter reports for `.furin/build/manifest.json`. */
export interface AdapterTargetManifest {
  buildId: string;
  generatedAt: string;
}

/**
 * A deployment target. The framework builds client assets, one production
 * server bundle whose entry is `runtimeModule`, and the build-time prerender
 * output; `onBuildComplete()` maps that output to the platform.
 */
export interface FurinAdapter {
  /** What the platform provides; baked into the build and read by the runtime. */
  readonly capabilities: AdapterCapabilities;
  /** Target name: build directory, analysis files and manifest key. */
  readonly name: string;
  readonly onBuildComplete: (output: AdapterBuildOutput) => Promise<AdapterTargetManifest>;
  /**
   * Absolute path of the typed module bundled as the server entry. It imports
   * the application from the `furin:app` specifier; its file name names the
   * emitted entry (`server.ts` → `server.js`).
   */
  readonly runtimeModule: string;
}
