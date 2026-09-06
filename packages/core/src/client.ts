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
export { type HotComponentRegistry, updateHotComponent } from "./client/hmr.ts";
export {
  type SyncMutation,
  type SyncMutationContext,
  type SyncMutationErrorContext,
  type SyncMutationHeaders,
  type SyncMutationOptions,
  type SyncMutationRunner,
  type SyncMutationSuccessContext,
  type UseSyncOptions,
  useSync,
} from "./client/sync.ts";
export { Await, useAsyncError, useAsyncValue } from "./shared/await.tsx";

export type RenderingMode = "ssr" | "ssg" | "isr";

const DEFERRED_BRAND: unique symbol = Symbol.for("@teyik0/furin/deferred");

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

// ── Deferred data ──────────────────────────────────────────────────────────────

/**
 * A loader return value that contains a mix of synchronous scalar fields and
 * lazy `Promise<T>` fields. Scalar fields are serialised into the initial HTML
 * shell; Promise fields are streamed as late `<script>` resolution chunks.
 *
 * @example
 * loader: () => defer({
 *   title: "My Board",          // synchronous — available immediately
 *   stats: fetchStats(),         // Promise — streamed when it resolves
 * })
 */
export type DeferredData<T extends object> = T & {
  readonly [DEFERRED_BRAND]: true;
};

/**
 * Wraps loader data so that Promise-valued fields are streamed lazily while
 * scalar fields are embedded in the initial HTML shell immediately.
 *
 * Use in any `defineRoute().loader()`. Promise-valued fields are streamed lazily;
 * scalar fields are embedded in the initial HTML shell.
 */
export function defer<T extends object>(
  data: T & { readonly [DEFERRED_BRAND]?: never }
): DeferredData<T> {
  if (Object.hasOwn(data, DEFERRED_BRAND)) {
    throw new Error("[furin] defer() received data that is already deferred.");
  }
  return { ...data, [DEFERRED_BRAND]: true };
}

/**
 * Type guard for DeferredData. Used by the render pipeline to distinguish a
 * plain loader return from a deferred one.
 */
export function isDeferred(value: unknown): value is DeferredData<object> {
  return (
    typeof value === "object" &&
    value !== null &&
    DEFERRED_BRAND in value &&
    Object.hasOwn(value, DEFERRED_BRAND) &&
    value[DEFERRED_BRAND] === true
  );
}
