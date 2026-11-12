import { join } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import type { CompileContext, CompileContextRoute } from "../../src/server/internal";

export interface FixtureRoute {
  /** Page file relative to `src/pages`. */
  file: string;
  mode: CompileContextRoute["mode"];
  pattern: string;
}

/**
 * Builds the compile context `furin build` would emit for a fixture app:
 * imports `src/pages/root.tsx` and each route file, and composes their
 * Elysia-native routes under the root.
 */
export async function createFixtureCompileContext(
  appPath: string,
  routes: FixtureRoute[]
): Promise<CompileContext> {
  const rootPath = join(appPath, "src/pages/root.tsx");
  const paths = routes.map((route) => join(appPath, "src/pages", route.file));
  const [rootMod, ...routeMods] = await Promise.all(
    [rootPath, ...paths].map((path) => import(path))
  );
  const nativeRoutes = routes.reduce(
    (root, route, index) =>
      root.use(
        new Elysia(route.pattern === "/" ? {} : { prefix: route.pattern }).use(
          (routeMods[index].route as { elysia: AnyElysia }).elysia
        )
      ),
    (rootMod.route as { elysia: AnyElysia }).elysia
  );

  return {
    modules: Object.fromEntries([
      [rootPath, rootMod],
      ...paths.map((path, index) => [path, routeMods[index]]),
    ]),
    nativeRoutes: new Elysia().use(nativeRoutes),
    rootConventions: {},
    rootPath,
    routeMetadata: Object.fromEntries(paths.map((path) => [path, { segmentBoundaries: [] }])),
    routes: routes.map((route, index) => ({
      mode: route.mode,
      path: paths[index] as string,
      pattern: route.pattern,
    })),
  };
}
