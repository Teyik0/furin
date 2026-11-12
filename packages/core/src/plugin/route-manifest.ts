import { existsSync, readdirSync } from "node:fs";
import { extname } from "node:path";

/**
 * File-routing convention of one `furin()` app. Both styles produce the same
 * manifest, keyed by TanStack Start ids, so switching style only renames files.
 */
export type RouteStyle = "nextjs" | "tanstack";

export interface RouteInstanceSpec {
  pagesDir: string;
  prefix: string;
  style: RouteStyle;
}

export interface RouteParam {
  /** `_splat` for a catch-all segment. */
  name: string;
  optional: boolean;
}

export interface ManifestRoute {
  /** `defineRoute(id)`: the app prefix, then the TanStack id (`/board/$boardId/` for an index). */
  id: string;
  kind: "layout" | "page";
  /** Path params of the route and its layouts, shallow → deep. */
  params: RouteParam[];
  /** Source of the parent layout; `undefined` when the root layout is the parent. */
  parentPath: string | undefined;
  /** URL pattern under the app prefix: `/board/:boardId`, `/docs/*`, `/:lang?/about`. */
  pattern: string;
  sourcePath: string;
}

/** A Next.js-style `error` / `not-found` pair declared in one directory. */
export interface ManifestBoundary {
  directory: string;
  errorPath: string | undefined;
  notFoundPath: string | undefined;
}

export interface RouteManifest {
  /** Directory boundaries, shallow → deep. Always empty in the TanStack style. */
  boundaries: ManifestBoundary[];
  /** Root layout module (`__root.tsx`, or `layout.tsx` at the top of a Next.js app). */
  rootPath: string;
  /** Layouts and pages in deterministic depth-first order. */
  routes: ManifestRoute[];
}

type Segment =
  | { type: "group"; raw: string }
  | { type: "param"; name: string; optional: boolean; raw: string }
  | { type: "pathless"; raw: string }
  | { type: "splat"; raw: string }
  | { type: "static"; raw: string; value: string };

interface Candidate {
  /** `route.tsx`, `layout.tsx` or a pathless file: a layout whatever its children. */
  forcedLayout: boolean;
  index: boolean;
  segments: Segment[];
  sourcePath: string;
}

interface StyleScan {
  boundaries: ManifestBoundary[];
  candidates: Candidate[];
  rootPath: string;
}

const ROUTE_EXTENSION = /\.(?:jsx?|tsx?)$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BRACKET_ESCAPE = /\[([^\]]*)\]/g;
const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];
/** `[...slug]` and the optional `[[...slug]]`. */
const NEXT_CATCH_ALL = /^\[\[?\.\.\.([^\]]+)\]\]?$/;

/** Posix paths on every platform: consumers compare and slice them by "/". */
function child(directory: string, name: string): string {
  return `${directory}/${name}`;
}

function sortedEntries(directory: string) {
  return readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

function moduleBase(name: string): string | undefined {
  if (name.endsWith(".d.ts") || !ROUTE_EXTENSION.test(name)) {
    return;
  }
  return name.slice(0, -extname(name).length);
}

function findModule(directory: string, base: string): string | undefined {
  return SOURCE_EXTENSIONS.map((extension) => child(directory, `${base}${extension}`)).find(
    (path) => existsSync(path)
  );
}

function paramName(name: string, raw: string, sourcePath: string): string {
  if (!PARAM_NAME.test(name)) {
    throw new Error(
      `[furin] Invalid dynamic parameter ${JSON.stringify(raw)} in ${JSON.stringify(sourcePath)}. Parameter names must match ${PARAM_NAME}.`
    );
  }
  return name;
}

// ── TanStack Start ──────────────────────────────────────────────────────────

/** Splits `posts.$postId.edit` on dots outside `[...]` escapes. */
function splitFlatName(base: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of base) {
    if (character === "[") {
      escaped = true;
    } else if (character === "]") {
      escaped = false;
    }
    if (character === "." && !escaped) {
      tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  tokens.push(current);
  return tokens;
}

function tanstackSegment(raw: string, sourcePath: string): Segment {
  if (raw.startsWith("(") && raw.endsWith(")")) {
    return { raw, type: "group" };
  }
  if (raw === "$") {
    return { raw, type: "splat" };
  }
  if (raw.startsWith("{-$") && raw.endsWith("}")) {
    return {
      name: paramName(raw.slice(3, -1), raw, sourcePath),
      optional: true,
      raw,
      type: "param",
    };
  }
  if (raw.startsWith("$")) {
    return { name: paramName(raw.slice(1), raw, sourcePath), optional: false, raw, type: "param" };
  }
  if (raw.startsWith("_")) {
    return { raw, type: "pathless" };
  }
  // `posts_` leaves the `posts` layout: same URL segment, different id.
  const value = (raw.endsWith("_") ? raw.slice(0, -1) : raw).replace(BRACKET_ESCAPE, "$1");
  return { raw, type: "static", value };
}

/** A TanStack route file: `index`, `route` and flat `a.$b` names under `segments`. */
function tanstackCandidate(base: string, segments: Segment[], sourcePath: string): Candidate {
  const tokens = splitFlatName(base);
  const last = tokens.at(-1);
  const index = last === "index";
  const routeFile = last === "route";
  const own = (index || routeFile ? tokens.slice(0, -1) : tokens).map((token) =>
    tanstackSegment(token, sourcePath)
  );
  const routeSegments = [...segments, ...own];
  if (routeFile && routeSegments.length === 0) {
    throw new Error(
      `[furin] ${sourcePath}: a top-level route.tsx has no path to wrap. The root layout lives in __root.tsx.`
    );
  }
  return {
    forcedLayout: routeFile || routeSegments.at(-1)?.type === "pathless",
    index,
    segments: routeSegments,
    sourcePath,
  };
}

function scanTanstack(pagesDir: string): StyleScan {
  const candidates: Candidate[] = [];
  const walk = (directory: string, segments: Segment[]): void => {
    for (const entry of sortedEntries(directory)) {
      if (entry.name.startsWith("-")) {
        continue;
      }
      const sourcePath = child(directory, entry.name);
      if (entry.isDirectory()) {
        walk(sourcePath, [...segments, tanstackSegment(entry.name, sourcePath)]);
        continue;
      }
      const base = moduleBase(entry.name);
      if (base !== undefined && !(segments.length === 0 && base === "__root")) {
        candidates.push(tanstackCandidate(base, segments, sourcePath));
      }
    }
  };
  walk(pagesDir, []);
  return {
    boundaries: [],
    candidates,
    rootPath: findModule(pagesDir, "__root") ?? child(pagesDir, "__root.tsx"),
  };
}

// ── Next.js App Router ──────────────────────────────────────────────────────

function nextSegment(name: string, sourcePath: string): Segment {
  if (name.startsWith("(") && name.endsWith(")")) {
    return { raw: name, type: "group" };
  }
  const catchAll = name.match(NEXT_CATCH_ALL);
  if (catchAll?.[1] !== undefined) {
    paramName(catchAll[1], name, sourcePath);
    return { raw: "$", type: "splat" };
  }
  if (name.startsWith("[") && name.endsWith("]")) {
    const name_ = paramName(name.slice(1, -1), name, sourcePath);
    return { name: name_, optional: false, raw: `$${name_}`, type: "param" };
  }
  return { raw: name, type: "static", value: name };
}

interface NextScanState {
  boundary: ManifestBoundary;
  candidates: Candidate[];
  rootPath: string | undefined;
}

/** Records one App Router file: a page, a layout, the root layout or a boundary. */
function addNextFile(
  state: NextScanState,
  base: string | undefined,
  segments: Segment[],
  sourcePath: string
): void {
  if (base === "route") {
    throw new Error(
      `[furin] ${sourcePath}: route handlers are not supported. Declare API routes on your Elysia app instead.`
    );
  }
  if (base === "page" || (base === "layout" && segments.length > 0)) {
    state.candidates.push({
      forcedLayout: base === "layout",
      // `docs/[...slug]/page.tsx` is TanStack's `docs/$.tsx`, not an index.
      index: base === "page" && segments.at(-1)?.type !== "splat",
      segments,
      sourcePath,
    });
  } else if (base === "layout") {
    state.rootPath ??= sourcePath;
  } else if (base === "error") {
    state.boundary.errorPath ??= sourcePath;
  } else if (base === "not-found") {
    state.boundary.notFoundPath ??= sourcePath;
  }
}

function scanNext(pagesDir: string): StyleScan {
  const candidates: Candidate[] = [];
  const boundaries: ManifestBoundary[] = [];
  let rootPath: string | undefined;
  const walk = (directory: string, segments: Segment[]): void => {
    const boundary: ManifestBoundary = { directory, errorPath: undefined, notFoundPath: undefined };
    const state: NextScanState = { boundary, candidates, rootPath };
    for (const entry of sortedEntries(directory)) {
      const sourcePath = child(directory, entry.name);
      if (!entry.isDirectory()) {
        addNextFile(state, moduleBase(entry.name), segments, sourcePath);
      } else if (!entry.name.startsWith("_")) {
        // `_folder` opts a folder out of routing, as in the App Router.
        walk(sourcePath, [...segments, nextSegment(entry.name, sourcePath)]);
      }
    }
    rootPath ??= state.rootPath;
    if (boundary.errorPath || boundary.notFoundPath) {
      boundaries.push(boundary);
    }
  };
  walk(pagesDir, []);
  // Parents first: the walk pushes a directory's boundary after its children.
  boundaries.sort((left, right) => left.directory.length - right.directory.length);
  return { boundaries, candidates, rootPath: rootPath ?? child(pagesDir, "layout.tsx") };
}

// ── Shared tree ─────────────────────────────────────────────────────────────

function segmentKey(segments: Segment[]): string {
  return segments.map((segment) => segment.raw).join("/");
}

function segmentPattern(segment: Segment): string | undefined {
  switch (segment.type) {
    case "group":
    case "pathless":
      return;
    case "param":
      return `:${segment.name}${segment.optional ? "?" : ""}`;
    case "splat":
      return "*";
    default:
      return segment.value;
  }
}

function urlPattern(segments: Segment[]): string {
  return `/${segments.flatMap((segment) => segmentPattern(segment) ?? []).join("/")}`;
}

function routeParams(segments: Segment[]): RouteParam[] {
  return segments.flatMap((segment): RouteParam[] => {
    if (segment.type === "param") {
      return [{ name: segment.name, optional: segment.optional }];
    }
    return segment.type === "splat" ? [{ name: "_splat", optional: false }] : [];
  });
}

function assertSplatLast(candidate: Candidate): void {
  const splat = candidate.segments.findIndex((segment) => segment.type === "splat");
  if (splat !== -1 && splat < candidate.segments.length - 1) {
    throw new Error(
      `[furin] ${candidate.sourcePath}: a catch-all segment must be the last segment of its path.`
    );
  }
}

/** Optional segments match like a missing segment, so `/:a?` and `/` collide. */
function patternKey(pattern: string): string {
  return pattern.replace(/(^|\/):[^/?]+(\?)?/g, (_, slash: string, optional?: string) =>
    optional ? `${slash}:optional` : `${slash}:param`
  );
}

function buildManifest(scan: StyleScan, pagesDir: string, prefix: string): RouteManifest {
  const relativePath = (path: string): string => path.slice(pagesDir.length + 1);
  const { candidates } = scan;
  const keys = candidates.map((candidate) => segmentKey(candidate.segments));
  const hasDescendant = (key: string, self: Candidate): boolean =>
    candidates.some(
      (other, index) =>
        other !== self &&
        (keys[index]?.startsWith(`${key}/`) === true || (other.index && keys[index] === key))
    );

  const layouts = new Map<string, string>();
  const kinds = candidates.map((candidate, index): ManifestRoute["kind"] => {
    assertSplatLast(candidate);
    const key = keys[index] ?? "";
    const isLayout = !candidate.index && (candidate.forcedLayout || hasDescendant(key, candidate));
    if (!isLayout) {
      return "page";
    }
    const existing = layouts.get(key);
    if (existing !== undefined) {
      throw new Error(
        `[furin] Two layouts wrap "/${key}": "${relativePath(existing)}" and "${relativePath(candidate.sourcePath)}".`
      );
    }
    layouts.set(key, candidate.sourcePath);
    return "layout";
  });

  const seenIds = new Map<string, string>();
  const seenPatterns = new Map<string, string>();
  const routes = candidates.map((candidate, index): ManifestRoute => {
    const kind = kinds[index] ?? "page";
    const { segments, sourcePath } = candidate;
    const key = keys[index] ?? "";
    // An index sits under the layout sharing its path; anything else under a strict ancestor.
    let parentPath = candidate.index ? layouts.get(key) : undefined;
    for (let depth = segments.length - 1; parentPath === undefined && depth > 0; depth -= 1) {
      parentPath = layouts.get(segmentKey(segments.slice(0, depth)));
    }
    const path = `/${key}${candidate.index && key !== "" ? "/" : ""}`;
    const id = prefix === "" ? path : `${prefix}${path}`;
    const previousId = seenIds.get(id);
    if (previousId !== undefined) {
      throw new Error(
        `[furin] Duplicate route id "${id}" from "${relativePath(previousId)}" and "${relativePath(sourcePath)}".`
      );
    }
    seenIds.set(id, sourcePath);
    const pattern = urlPattern(segments);
    if (kind === "page") {
      const previous = seenPatterns.get(patternKey(pattern));
      if (previous !== undefined) {
        throw new Error(
          `[furin] Duplicate route pattern "${patternKey(pattern)}" from "${relativePath(previous)}" and "${relativePath(sourcePath)}".`
        );
      }
      seenPatterns.set(patternKey(pattern), sourcePath);
    }
    return { id, kind, params: routeParams(segments), parentPath, pattern, sourcePath };
  });

  return { boundaries: scan.boundaries, rootPath: scan.rootPath, routes };
}

/**
 * The single filesystem walk behind every route consumer (route tree,
 * discovery, typegen, route-config checks, dev topology).
 */
export function scanRouteManifest({ pagesDir, prefix, style }: RouteInstanceSpec): RouteManifest {
  const directory = pagesDir.replaceAll("\\", "/");
  return buildManifest(
    style === "nextjs" ? scanNext(directory) : scanTanstack(directory),
    directory,
    prefix
  );
}
