import type { RuntimeData } from "../client/internal/runtime-types.ts";
import type { FurinServerErrorPayload } from "../client/server-error.ts";

/**
 * Payload key carrying one serialized match per route segment: each
 * route-chain entry (index 0 = root), then the page. The same shape describes
 * success, loader errors, `notFound()` and shell failures.
 */
export const ROUTE_MATCHES_KEY = "__furinMatches";

export interface RouteNotFoundPayload {
  data?: unknown;
  message?: string;
}

export type RouteMatchFailure =
  | { error: FurinServerErrorPayload; status: "error" }
  | { error: RouteNotFoundPayload; status: "notFound" };

/**
 * Wire form of a match. A successful segment maps each of its own loader
 * fields to the payload key holding the value: the field name itself, or a
 * `__furinMatch` slot when a deeper loader overwrote that name in the page data.
 * Segments after a failure are absent.
 */
export type SerializedRouteMatch =
  | { fields: { [field: string]: string }; status: "success" }
  | RouteMatchFailure;

export function serializedRouteMatches(data: RuntimeData): SerializedRouteMatch[] {
  return (data[ROUTE_MATCHES_KEY] as SerializedRouteMatch[] | undefined) ?? [];
}

/** The failed segment, when the payload carries one. */
export function findRouteFailure(
  data: RuntimeData
): (RouteMatchFailure & { index: number }) | undefined {
  const matches = serializedRouteMatches(data);
  const index = matches.findIndex((match) => match.status !== "success");
  const failure = matches[index];
  return failure && failure.status !== "success" ? { ...failure, index } : undefined;
}

/** Index of the segment a loader failure belongs to: the first one without data. */
export function loaderFailureIndex(data: RuntimeData): number {
  return findRouteFailure(data)?.index ?? serializedRouteMatches(data).length;
}

/** Marks segment `index` as failed; later segments are dropped. */
export function failRouteMatches<Data extends RuntimeData>(
  data: Data,
  index: number,
  failure: RouteMatchFailure
): Data {
  return {
    ...data,
    [ROUTE_MATCHES_KEY]: [...serializedRouteMatches(data).slice(0, index), failure],
  };
}
