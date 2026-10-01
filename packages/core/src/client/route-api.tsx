import type { RoutePatternMap } from "@teyik0/furin/routes";
import { type Context, createContext, createElement, type ReactNode, useContext } from "react";
import type { RouteLoaderData, RouteParams } from "../define-route.ts";

interface RouteSnapshot {
  data: object;
  params: object;
  pattern: string;
}

const RESERVED_RENDER_KEYS = new Set([
  "catch",
  "children",
  "finally",
  "key",
  "ref",
  "then",
  "toJSON",
]);

// Separate client entrypoints share the context, never request-specific data.
const ROUTE_CONTEXT = Symbol.for("furin.route.context.v1");
const contextGlobal = globalThis as typeof globalThis & {
  [ROUTE_CONTEXT]?: Context<RouteSnapshot | null>;
};
const RouteContext = (contextGlobal[ROUTE_CONTEXT] ??= createContext<RouteSnapshot | null>(null));

type ResolvedRouteParams<Route> = [RouteParams<Route>] extends [never]
  ? Record<PropertyKey, never>
  : unknown extends RouteParams<Route>
    ? Record<PropertyKey, never>
    : keyof RouteParams<Route> extends never
      ? Record<PropertyKey, never>
      : RouteParams<Route>;

/** @internal Supplies the same rendered snapshot on the server and client. */
export function withRouteSnapshot(element: ReactNode, pattern: string, props: object): ReactNode {
  const {
    params,
    path: _path,
    query: _query,
    ...data
  } = props as {
    params?: object;
    path?: string;
    query?: object;
  };
  const loaderData = Object.fromEntries(
    Object.entries(data).filter(
      ([key]) => !(RESERVED_RENDER_KEYS.has(key) || key.startsWith("__furin"))
    )
  );
  return createElement(
    RouteContext.Provider,
    { value: { data: loaderData, params: params ?? {}, pattern } },
    element
  );
}

function useRouteSnapshot(pattern: string): RouteSnapshot {
  const snapshot = useContext(RouteContext);
  if (snapshot?.pattern !== pattern) {
    throw new Error(`[furin] getRouteApi("${pattern}") does not match the active route.`);
  }
  return snapshot;
}

export function getRouteApi<Pattern extends keyof RoutePatternMap & string>(pattern: Pattern) {
  return {
    useLoaderData: (): RouteLoaderData<RoutePatternMap[Pattern]> =>
      useRouteSnapshot(pattern).data as RouteLoaderData<RoutePatternMap[Pattern]>,
    useParams: (): ResolvedRouteParams<RoutePatternMap[Pattern]> =>
      useRouteSnapshot(pattern).params as ResolvedRouteParams<RoutePatternMap[Pattern]>,
  };
}
