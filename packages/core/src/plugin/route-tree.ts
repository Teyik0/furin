import { existsSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import {
  filePathToPattern,
  parseDynamicRouteSegment,
  routePatternKey,
  routeSegmentToPattern,
} from "../server/router/patterns.ts";

const ROUTE_EXTENSION = /\.(?:jsx?|tsx?)$/;
const ROUTE_CONVENTIONS = new Set(["error", "not-found", "root"]);

export interface RouteInstanceSpec {
  pagesDir: string;
  prefix: string;
}

export function instanceKey(instance: RouteInstanceSpec): string {
  return `${resolve(instance.pagesDir)}\0${instance.prefix}`;
}

export function routeModuleSpecifier(instance: RouteInstanceSpec): string {
  return `@teyik0/furin/routes?instance=${Bun.hash(instanceKey(instance)).toString(16)}`;
}

export interface RouteFile {
  id: string;
  path: string;
  sourcePath: string;
}

export interface RouteTreeNode {
  children: RouteTreeNode[];
  fileRoutes: RouteFile[];
  indexRoute: RouteFile | undefined;
  layout: RouteFile | undefined;
  name: string;
}

interface ScannedRouteFile {
  base: string;
  directorySegments: string[];
  sourcePath: string;
}

function scanRouteFiles(
  directory: string,
  directorySegments: string[],
  files: ScannedRouteFile[]
): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Underscore-prefixed directories are co-located private folders
      // (components, libs) — never route segments.
      if (entry.name.startsWith("_")) {
        continue;
      }
      scanRouteFiles(join(directory, entry.name), [...directorySegments, entry.name], files);
      continue;
    }
    const extension = extname(entry.name);
    if (!ROUTE_EXTENSION.test(extension) || entry.name.endsWith(".d.ts")) {
      continue;
    }
    const base = entry.name.slice(0, -extension.length);
    const sourcePath = join(directory, entry.name);
    for (const segment of [...directorySegments, base]) {
      parseDynamicRouteSegment(segment, sourcePath);
    }
    if (ROUTE_CONVENTIONS.has(base)) {
      continue;
    }
    // Underscore-prefixed files are private co-located modules — except the
    // `_route` layout convention, resolved downstream by buildRouteTree.
    if (base.startsWith("_") && base !== "_route") {
      continue;
    }
    files.push({
      base,
      directorySegments,
      sourcePath,
    });
  }
}

const INDEX_SUFFIX = /\/index$/;

/**
 * Id of a keyed `defineRoute(id)`: the file's path under `pagesDir` with
 * brackets and groups, `/index` dropped (`board/[boardId]/index.tsx` →
 * `/board/[boardId]`, `board/_route.tsx` → `/board/_route`).
 */
export function fileRouteId(pagesDir: string, sourcePath: string): string {
  const path = relative(pagesDir, sourcePath).replaceAll("\\", "/").replace(ROUTE_EXTENSION, "");
  return `/${path}`.replace(INDEX_SUFFIX, "") || "/";
}

export function segmentPath(segment: string): string {
  return routeSegmentToPattern(segment);
}

function routeId(instanceId: string, path: string): string {
  const encodedPath = Array.from(new TextEncoder().encode(path), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `_route_${instanceId}_${encodedPath}`;
}

export interface RouteManifestFile {
  base: string;
  directorySegments: string[];
  /** URL pattern of a page; `undefined` for a `_route` layout. */
  pattern: string | undefined;
  sourcePath: string;
}

/**
 * The single filesystem walk behind every route consumer (native route tree,
 * `scanPages`, typegen, adapters): files in deterministic depth-first order,
 * dynamic segments validated and duplicate URL patterns rejected.
 */
export function scanRouteManifest(pagesDir: string): RouteManifestFile[] {
  const scannedFiles: ScannedRouteFile[] = [];
  scanRouteFiles(pagesDir, [], scannedFiles);
  const seenPatterns = new Map<string, string>();
  return scannedFiles.map((file) => {
    if (file.base === "_route") {
      return { ...file, pattern: undefined };
    }
    const relativePath = relative(pagesDir, file.sourcePath).replaceAll("\\", "/");
    const pattern = filePathToPattern(relativePath);
    const patternKey = routePatternKey(pattern);
    const previousPath = seenPatterns.get(patternKey);
    if (previousPath !== undefined) {
      throw new Error(
        `[furin] Duplicate route pattern "${patternKey}" from "${previousPath}" and "${relativePath}".`
      );
    }
    seenPatterns.set(patternKey, relativePath);
    return { ...file, pattern };
  });
}

export function buildRouteTree(pagesDir: string, instanceId: string): RouteTreeNode {
  const nodes = new Map<string, RouteTreeNode>();

  const ensureNode = (segments: string[]): RouteTreeNode => {
    const key = segments.join("/");
    const existing = nodes.get(key);
    if (existing) {
      return existing;
    }
    const node: RouteTreeNode = {
      children: [],
      fileRoutes: [],
      indexRoute: undefined,
      layout: undefined,
      name: segments.at(-1) ?? "",
    };
    nodes.set(key, node);
    if (segments.length > 0) {
      ensureNode(segments.slice(0, -1)).children.push(node);
    }
    return node;
  };
  const root = ensureNode([]);

  for (const file of scanRouteManifest(pagesDir)) {
    const node = ensureNode(file.directorySegments);
    if (file.pattern === undefined) {
      const path = `/${file.directorySegments.map(segmentPath).join("/")}#layout`;
      node.layout = { id: routeId(instanceId, path), path: "", sourcePath: file.sourcePath };
      continue;
    }
    const route = {
      id: routeId(instanceId, file.pattern),
      path: file.pattern,
      sourcePath: file.sourcePath,
    };
    if (file.base === "index") {
      node.indexRoute = route;
    } else {
      node.fileRoutes.push(route);
    }
  }
  return root;
}

export function collectRouteFiles(root: RouteTreeNode): RouteFile[] {
  const files: RouteFile[] = [];
  const nodes = [root];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (!node) {
      continue;
    }
    if (node.layout) {
      files.push(node.layout);
    }
    if (node.indexRoute) {
      files.push(node.indexRoute);
    }
    files.push(...node.fileRoutes);
    nodes.push(...node.children);
  }
  return files;
}

export function routeSourcePaths(instance: RouteInstanceSpec): string[] {
  const instanceId = Bun.hash(instanceKey(instance)).toString(16);
  return collectRouteFiles(buildRouteTree(instance.pagesDir, instanceId))
    .map(({ sourcePath }) => resolve(sourcePath))
    .toSorted((left, right) => left.localeCompare(right));
}

function conventionSourcePaths(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!entry.name.startsWith("_")) {
        paths.push(...conventionSourcePaths(join(directory, entry.name)));
      }
      continue;
    }
    const extension = extname(entry.name);
    if (!ROUTE_EXTENSION.test(extension) || entry.name.endsWith(".d.ts")) {
      continue;
    }
    const base = entry.name.slice(0, -extension.length);
    if (base === "error" || base === "not-found") {
      paths.push(resolve(directory, entry.name));
    }
  }
  return paths;
}

export function routeSnapshotSourcePaths(instance: RouteInstanceSpec): string[] {
  const rootPath = resolve(instance.pagesDir, "root.tsx");
  return [
    ...(existsSync(rootPath) ? [rootPath] : []),
    ...routeSourcePaths(instance),
    ...conventionSourcePaths(instance.pagesDir),
  ].toSorted((left, right) => left.localeCompare(right));
}
