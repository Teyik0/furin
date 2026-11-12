import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type ManifestRoute, type RouteInstanceSpec, scanRouteManifest } from "./route-manifest.ts";

export type { RouteInstanceSpec } from "./route-manifest.ts";

export function instanceKey(instance: RouteInstanceSpec): string {
  return `${resolve(instance.pagesDir)}\0${instance.prefix}`;
}

export function routeModuleSpecifier(instance: RouteInstanceSpec): string {
  return `@teyik0/furin/routes?instance=${Bun.hash(instanceKey(instance)).toString(16)}`;
}

export interface RouteFile {
  id: string;
  /** URL pattern of a page; `""` for a layout. */
  path: string;
  /** Mount prefix relative to the enclosing layout. */
  prefix: string;
  /** Native absolute path, as route modules are loaded and cached by it. */
  sourcePath: string;
}

/** A layout and everything it wraps, following the manifest's parent links. */
export interface RouteTreeNode {
  children: RouteTreeNode[];
  /** `undefined` for the root node: the root layout's Elysia is never mounted. */
  layout: RouteFile | undefined;
  pages: RouteFile[];
  /** Mount prefix relative to the parent node. */
  prefix: string;
}

function routeId(instanceId: string, id: string): string {
  const encodedId = Array.from(new TextEncoder().encode(id), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `_route_${instanceId}_${encodedId}`;
}

/** `pattern` with the part its layout already mounts removed. */
function relativePrefix(pattern: string, parentPattern: string): string {
  const own = pattern === "/" ? "" : pattern;
  const parent = parentPattern === "/" ? "" : parentPattern;
  if (!own.startsWith(parent)) {
    throw new Error(
      `[furin] Route pattern "${pattern}" does not extend its layout's "${parentPattern}".`
    );
  }
  return own.slice(parent.length);
}

export function buildRouteTree(instance: RouteInstanceSpec, instanceId: string): RouteTreeNode {
  const { routes } = scanRouteManifest(instance);
  const byPath = new Map(routes.map((route) => [route.sourcePath, route]));
  const root: RouteTreeNode = { children: [], layout: undefined, pages: [], prefix: "" };
  const nodes = new Map<string | undefined, RouteTreeNode>([[undefined, root]]);
  const parentPattern = (route: ManifestRoute): string =>
    route.parentPath === undefined ? "/" : (byPath.get(route.parentPath)?.pattern ?? "/");

  const ensureNode = (sourcePath: string | undefined): RouteTreeNode => {
    const existing = nodes.get(sourcePath);
    if (existing) {
      return existing;
    }
    const layout = sourcePath === undefined ? undefined : byPath.get(sourcePath);
    if (!layout) {
      return root;
    }
    const prefix = relativePrefix(layout.pattern, parentPattern(layout));
    const node: RouteTreeNode = {
      children: [],
      layout: {
        id: routeId(instanceId, layout.id),
        path: "",
        prefix,
        sourcePath: resolve(layout.sourcePath),
      },
      pages: [],
      prefix,
    };
    nodes.set(sourcePath, node);
    ensureNode(layout.parentPath).children.push(node);
    return node;
  };

  for (const route of routes) {
    if (route.kind === "layout") {
      ensureNode(route.sourcePath);
      continue;
    }
    ensureNode(route.parentPath).pages.push({
      id: routeId(instanceId, route.id),
      path: route.pattern,
      prefix: relativePrefix(route.pattern, parentPattern(route)),
      sourcePath: resolve(route.sourcePath),
    });
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
    files.push(...node.pages);
    nodes.push(...node.children);
  }
  return files;
}

export function routeSourcePaths(instance: RouteInstanceSpec): string[] {
  return scanRouteManifest(instance)
    .routes.map(({ sourcePath }) => resolve(sourcePath))
    .toSorted((left, right) => left.localeCompare(right));
}

/** Every file whose presence shapes the app: root, routes and boundary files. */
export function routeSnapshotSourcePaths(instance: RouteInstanceSpec): string[] {
  const { boundaries, rootPath, routes } = scanRouteManifest(instance);
  return [
    ...(existsSync(rootPath) ? [rootPath] : []),
    ...routes.map(({ sourcePath }) => sourcePath),
    ...boundaries.flatMap(({ errorPath, notFoundPath }) =>
      [errorPath, notFoundPath].filter((path) => path !== undefined)
    ),
  ]
    .map((path) => resolve(path))
    .toSorted((left, right) => left.localeCompare(right));
}
