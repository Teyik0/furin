const DEFERRED_BRAND: unique symbol = Symbol.for("@teyik0/furin/deferred");

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
