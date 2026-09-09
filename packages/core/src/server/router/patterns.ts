import { parse } from "node:path";
import type { RuntimePage, RuntimeRoute } from "../../client/internal/runtime-types.ts";

export function collectIntermediateLayoutDirs(pagePath: string, rootPath: string): string[] {
  const pageDir = pagePath.slice(0, pagePath.lastIndexOf("/"));
  const pagesDir = rootPath.slice(0, rootPath.lastIndexOf("/"));
  const layoutDirs: string[] = [];
  let dir = pageDir;

  while (dir.length > pagesDir.length) {
    layoutDirs.unshift(dir);
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }

  return layoutDirs;
}

export function resolveMode(page: RuntimePage, routeChain: RuntimeRoute[]): "ssr" | "ssg" | "isr" {
  const routeConfig = page._route;
  const mode = routeConfig.mode ?? page.mode;
  const revalidate = routeConfig.revalidate ?? page.revalidate;

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

const DYNAMIC_PARAMETER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DynamicRouteSegment {
  catchAll: boolean;
  name: string;
}

export function parseDynamicRouteSegment(
  segment: string,
  sourcePath: string | undefined
): DynamicRouteSegment | undefined {
  if (!(segment.startsWith("[") && segment.endsWith("]"))) {
    return;
  }
  const inner = segment.slice(1, -1);
  const catchAll = inner.startsWith("...");
  const name = catchAll ? inner.slice(3) : inner;
  if (!DYNAMIC_PARAMETER_NAME_RE.test(name)) {
    throw new Error(
      `[furin] Invalid dynamic parameter ${JSON.stringify(name)} in ${JSON.stringify(
        sourcePath ?? segment
      )}. Parameter names must match ${DYNAMIC_PARAMETER_NAME_RE}.`
    );
  }
  return { catchAll, name };
}

export function routeSegmentToPattern(segment: string): string {
  const dynamic = parseDynamicRouteSegment(segment, undefined);
  if (!dynamic) {
    return segment;
  }
  return dynamic.catchAll ? "*" : `:${dynamic.name}`;
}

export function filePathToPattern(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  const segments: string[] = [];
  const lastIndex = parts.length - 1;

  for (let idx = 0; idx < parts.length; idx += 1) {
    const part = parts[idx];
    if (part === undefined || part.length === 0) {
      continue;
    }

    // Only the leaf (file) segment carries an extension to strip. Directory
    // segments are kept verbatim so valid folder names with dots — e.g.
    // `v1.0` — are not truncated into `v1` by `parse().ext` handling.
    const isFile = idx === lastIndex;
    const name = isFile ? parse(part).name : part;

    // `index` collapses to its parent ONLY as a leaf filename. A directory
    // literally named `index` is a real route segment and must be preserved.
    if (isFile && name === "index") {
      continue;
    }

    const dynamic = parseDynamicRouteSegment(name, path);
    if (dynamic) {
      segments.push(dynamic.catchAll ? "*" : `:${dynamic.name}`);
    } else {
      segments.push(name);
    }
  }

  return `/${segments.join("/")}`;
}

const REGEX_META_CHARS_RE = /[.*+?^${}()|[\]\\]/;

export function escapeRegExpChar(ch: string): string {
  return REGEX_META_CHARS_RE.test(ch) ? `\\${ch}` : ch;
}

/**
 * Ranks a single route segment by how tightly it constrains a URL position:
 * a literal segment outranks a `:param`, which outranks a `*` wildcard.
 */
function segmentSpecificity(segment: string): number {
  if (segment === "*") {
    return 1;
  }
  if (segment.startsWith(":")) {
    return 2;
  }
  return 3;
}

/**
 * Compares two route patterns by specificity so the `/_furin/data` matcher can
 * prefer the more specific of two siblings that both match a pathname.
 *
 * Patterns are compared segment by segment from the left; the first position
 * where they differ decides (literal > `:param` > `*`). When every shared
 * position ties, the pattern with more explicit segments wins over a shorter
 * one whose wildcard absorbs the tail.
 *
 * Returns a positive number when `a` is MORE specific than `b`, negative when
 * less, and `0` only when the two are indistinguishable. This lexicographic
 * ranking replaces the previous summed-weight score, which produced ties such
 * as `/blog/new/:section` vs `/blog/:id/edit` (both summed to 8) that resolved
 * non-deterministically by scan order.
 */
export function compareRouteSpecificity(a: string, b: string): number {
  const aSegments = a.split("/").filter((segment) => segment.length > 0);
  const bSegments = b.split("/").filter((segment) => segment.length > 0);
  const length = Math.max(aSegments.length, bSegments.length);
  for (let i = 0; i < length; i += 1) {
    const aSegment = aSegments[i];
    const bSegment = bSegments[i];
    // The pattern that still has a segment here constrains one more position.
    if (aSegment === undefined) {
      return bSegment === "*" ? 1 : -1;
    }
    if (bSegment === undefined) {
      return aSegment === "*" ? -1 : 1;
    }
    const diff = segmentSpecificity(aSegment) - segmentSpecificity(bSegment);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Builds a regex from a route pattern, extracts named capture groups for
 * each `:param` segment, and returns `{ regex, paramNames }`.
 *
 * Literal characters (e.g. dots in filenames like `v1.0`) are escaped so
 * they are matched exactly rather than interpreted as regex syntax.
 */
export function buildRouteRegex(pattern: string): { regex: RegExp; paramNames: string[] } {
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
      paramNames.push(pattern.slice(start, i));
      source += "([^/]+)";
    } else if (pattern[i] === "*") {
      paramNames.push("*");
      source += "(.*)";
      i += 1;
    } else {
      const ch = pattern[i];
      if (ch !== undefined) {
        source += escapeRegExpChar(ch);
      }
      i += 1;
    }
  }
  return { paramNames, regex: new RegExp(`^${source}$`) };
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
        if (name !== undefined) {
          params[name] = match[i + 1] ?? "";
        }
      }
      return { params, route: candidate.route };
    }
    return null;
  };
}
