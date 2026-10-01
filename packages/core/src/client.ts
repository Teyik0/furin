/*
  biome-ignore-all lint/performance/noBarrelFile: client.ts is the canonical DX
  entry for furin/client consumers, not a generic internal barrel.
*/

export { defineRootRoute, defineRoute } from "./client/define-route.ts";
export {
  type DocumentAssets,
  DocumentProvider,
  type DocumentState,
  HeadContent,
  Scripts,
} from "./client/document.tsx";
export {
  type HotComponentRegistry,
  reconcileHotComponentRegistry,
  updateHotComponent,
} from "./client/hmr.ts";
export { useQuery } from "./client/query.tsx";
export {
  createClient,
  type OptimisticCache,
  type SyncCallOptions,
  type SyncClientOptions,
  withSync,
} from "./client/sync.ts";
export { Await, useAsyncError, useAsyncValue } from "./shared/await.tsx";

export { type DeferredData, defer, isDeferred } from "./shared/defer.ts";

export type RenderingMode = "ssr" | "ssg" | "isr";

export type MetaDescriptor =
  | { charSet: "utf-8" }
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string }
  | { httpEquiv: string; content: string }
  | { "script:ld+json": object }
  | { tagName: "meta" | "link"; [name: string]: string | undefined };

export interface HeadOptions {
  links?: Array<{ rel: string; href: string; [key: string]: string }>;
  meta?: MetaDescriptor[];
  /**
   * Inline scripts injected into `<head>`.
   *
   * **Security warning:** `children` is injected as raw HTML — never pass
   * user-controlled or loader-derived data here without sanitisation.
   */
  scripts?: Array<{
    src?: string;
    type?: string;
    children?: string;
    [key: string]: string | undefined;
  }>;
  /**
   * Inline styles injected into `<head>`.
   *
   * **Security warning:** `children` is injected as raw HTML — never pass
   * user-controlled or loader-derived data here without sanitisation.
   */
  styles?: Array<{ type?: string; children: string }>;
}
