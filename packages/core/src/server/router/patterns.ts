import type { RuntimePage, RuntimeRoute } from "../../client/internal/runtime-types.ts";
import { compareRouteSpecificity } from "../../shared/route-specificity.ts";
import type { ResolvedRoute } from "./types.ts";

// biome-ignore lint/performance/noBarrelFile: preserve the existing comparator import while sharing its implementation with the client.
export { compareRouteSpecificity } from "../../shared/route-specificity.ts";

export function resolveRouteRevalidate(page: RuntimePage): number | undefined {
  return page.revalidate ?? page._route.revalidate;
}

export function resolveDocumentMode(route: ResolvedRoute): "ssr" | "ssg" | "isr" {
  if (
    route.mode === "ssr" ||
    route.routeChain.some((entry) => entry.mode === "ssr" && entry.loader !== undefined)
  ) {
    return "ssr";
  }
  return route.mode === "isr" ||
    route.routeChain.some((entry) => entry.mode === "isr" && entry.loader !== undefined)
    ? "isr"
    : "ssg";
}

export function resolveDocumentRevalidate(route: ResolvedRoute): number | undefined {
  if (resolveDocumentMode(route) !== "isr") {
    return;
  }
  const intervals = route.routeChain
    .filter((entry) => entry.mode === "isr" && entry.loader !== undefined)
    .map((entry) => entry.revalidate ?? 60);
  if (route.mode === "isr") {
    intervals.push(resolveRouteRevalidate(route.page) ?? 60);
  }
  return Math.min(...intervals);
}

export function resolveMode(page: RuntimePage, routeChain: RuntimeRoute[]): "ssr" | "ssg" | "isr" {
  const routeConfig = page._route;
  const mode = routeConfig.mode ?? page.mode;
  const revalidate = resolveRouteRevalidate(page);

  if (mode) {
    return mode;
  }

  const hasLoader = routeChain.some((r) => r.loader) || !!page.loader;
  const hasQuery = routeChain.some((r) => r.query);

  if (hasQuery) {
    return "ssr";
  }

  if (!hasLoader) {
    return "ssg";
  }

  if (typeof revalidate === "number" && revalidate >= 0) {
    return "isr";
  }

  return "ssr";
}

/** Param name of a catch-all segment (`*` in patterns), as in TanStack Start. */
export const SPLAT_PARAM = "_splat";

const REGEX_META_CHARS_RE = /[.*+?^${}()|[\]\\]/g;

export function escapeRegExp(value: string): string {
  return value.replace(REGEX_META_CHARS_RE, "\\$&");
}

/**
 * Unanchored regex source for a route pattern: literal characters (e.g. dots
 * in `v1.0`) are escaped, each `:param` becomes `sources.param` and `*`
 * becomes `sources.catchAll`. `paramNames` lists them in order (`*` for the
 * catch-all).
 */
export function routePatternRegexSource(
  pattern: string,
  sources: { catchAll: string; param: string }
): { paramNames: string[]; source: string } {
  const paramNames: string[] = [];
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === ":") {
      i += 1;
      const start = i;
      while (i < pattern.length && pattern[i] !== "/") {
        i += 1;
      }
      const name = pattern.slice(start, i);
      if (name.endsWith("?") && source.endsWith("/")) {
        // `/:lang?` matches with or without its segment, slash included.
        paramNames.push(name.slice(0, -1));
        source = `${source.slice(0, -1)}(?:/${sources.param})?`;
      } else {
        paramNames.push(name);
        source += sources.param;
      }
    } else if (pattern[i] === "*") {
      paramNames.push(SPLAT_PARAM);
      source += sources.catchAll;
      i += 1;
    } else {
      const ch = pattern[i];
      if (ch !== undefined) {
        source += escapeRegExp(ch);
      }
      i += 1;
    }
  }
  return { paramNames, source };
}

/**
 * Builds an anchored regex from a route pattern with one capture group per
 * `:param` / `*` segment, and returns `{ regex, paramNames }`.
 */
export function buildRouteRegex(pattern: string): { regex: RegExp; paramNames: string[] } {
  const { paramNames, source } = routePatternRegexSource(pattern, {
    catchAll: "(.*)",
    param: "([^/]+)",
  });
  return {
    paramNames,
    regex: new RegExp(`^${source}${pattern === "/" || pattern.endsWith("/") ? "" : "/?"}$`),
  };
}

export interface RoutePatternLike {
  pattern: string;
}

export interface RouteMatch<TRoute extends RoutePatternLike> {
  params: Record<string, string>;
  route: TRoute;
}

interface CompiledRoutePattern<TRoute extends RoutePatternLike> {
  paramNames: string[];
  regex: RegExp;
  route: TRoute;
}

export function buildRouteMatcher<TRoute extends RoutePatternLike>(
  routes: TRoute[]
): (pathname: string) => RouteMatch<TRoute> | null {
  const compiled = routes
    .map((route): CompiledRoutePattern<TRoute> => {
      const { regex, paramNames } = buildRouteRegex(route.pattern);
      return { paramNames, regex, route };
    })
    .sort((a, b) => compareRouteSpecificity(b.route.pattern, a.route.pattern));

  return (pathname) => {
    for (const candidate of compiled) {
      const match = candidate.regex.exec(pathname);
      if (!match) {
        continue;
      }
      const params: Record<string, string> = {};
      for (let i = 0; i < candidate.paramNames.length; i += 1) {
        const name = candidate.paramNames[i];
        // An optional segment that did not match leaves its param unset.
        if (name !== undefined && match[i + 1] !== undefined) {
          try {
            params[name] = decodeURIComponent(match[i + 1] ?? "");
          } catch {
            params[name] = match[i + 1] ?? "";
          }
        }
      }
      return { params, route: candidate.route };
    }
    return null;
  };
}
