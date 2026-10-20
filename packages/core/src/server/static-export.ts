import type { RuntimeParams } from "../client/internal/runtime-types.ts";
import { mapWithConcurrency } from "../shared/utils/index.ts";
import { createInstance, withInstance } from "./instance.ts";
import { getCompileContext } from "./internal.ts";
import { prerenderSSG } from "./render/ssg.ts";
import { expandStaticPaths, type StaticPath } from "./render/static-params.ts";
import { setProductionPreloadManifest, setProductionTemplateContent } from "./render/template.ts";
import { loadProdRoutes } from "./router/discovery.ts";
import { buildRouteMatcher } from "./router/patterns.ts";
import { createSearchRouteMetadata } from "./router/schemas.ts";
import type { ResolvedRoute } from "./router/types.ts";

// Runs inside the temporary static-export bundle, in a child process: the
// build only receives serializable pages and writes them to disk itself.

/** Maximum concurrent staticParams() and render calls (mirrors warmSSGCache). */
const STATIC_CONCURRENCY = 4;

const STATIC_RENDER_ORIGIN = "http://localhost";

export interface StaticExportOptions {
  basePath: string;
  /** SSG route patterns the build validated as exportable. */
  patterns: string[];
}

interface StaticExportPageBase {
  params: RuntimeParams;
  path: string;
  pattern: string;
}

export type StaticExportPage = StaticExportPageBase &
  ({ html: string; ndjson: string } | { redirect: string });

export interface StaticExportFailure {
  /** Stack or message of the thrown value. */
  error: string;
  params: RuntimeParams | undefined;
  path: string;
  pattern: string;
}

export interface StaticExportResult {
  /** Dynamic routes without staticParams(). */
  missingParams: string[];
  pages: StaticExportPage[];
  /** Routes whose staticParams() threw (`path` is the pattern). */
  paramsFailures: StaticExportFailure[];
  renderFailures: StaticExportFailure[];
}

function describeError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

async function renderPage(
  route: ResolvedRoute,
  { params, path }: StaticPath,
  render: () => ReturnType<typeof prerenderSSG>
): Promise<StaticExportPage | StaticExportFailure> {
  const base = { params, path, pattern: route.pattern };
  try {
    const entry = await render();
    if (!(entry instanceof Response)) {
      return { ...base, html: entry.html, ndjson: entry.ndjson };
    }
    const location = entry.headers.get("location");
    if (entry.status < 300 || entry.status >= 400 || location === null) {
      throw new Error(
        `[furin] static: route "${route.pattern}" returned a response that cannot be exported.`
      );
    }
    return { ...base, redirect: location };
  } catch (err) {
    return { ...base, error: describeError(err) };
  }
}

/**
 * Expands staticParams() and renders every exportable page of the sole
 * compiled app, in a private runtime primed with the static shell.
 */
export async function exportStaticPages(options: StaticExportOptions): Promise<StaticExportResult> {
  const ctx = getCompileContext();
  if (ctx?.templateHtml === undefined) {
    throw new Error("[furin] static: the export bundle registered no static shell.");
  }
  const { root, routes } = loadProdRoutes(ctx);
  const runtime = createInstance("", ctx.rootPath.slice(0, ctx.rootPath.lastIndexOf("/")));
  setProductionTemplateContent(ctx.templateHtml, runtime);
  if (ctx.preloadManifest) {
    setProductionPreloadManifest(ctx.preloadManifest, runtime);
  }

  const ssgRoutes = routes.filter((route) => options.patterns.includes(route.pattern));
  const searchRoutes = createSearchRouteMetadata(ssgRoutes);
  // Ownership is decided against every route, exported or not, so a
  // staticParams() value never overwrites the page of a more specific route.
  const matchRoute = buildRouteMatcher(routes);
  const result: StaticExportResult = {
    missingParams: [],
    pages: [],
    paramsFailures: [],
    renderFailures: [],
  };

  await withInstance(runtime, async () => {
    const expanded = await mapWithConcurrency(ssgRoutes, STATIC_CONCURRENCY, async (route) => {
      try {
        return { paths: await expandStaticPaths(route, matchRoute, STATIC_RENDER_ORIGIN), route };
      } catch (err) {
        result.paramsFailures.push({
          error: describeError(err),
          params: undefined,
          path: route.pattern,
          pattern: route.pattern,
        });
        return { paths: [], route };
      }
    });
    const tasks = expanded.flatMap(({ paths, route }) => {
      if (paths === undefined) {
        result.missingParams.push(route.pattern);
        return [];
      }
      return paths.map((path) => ({ path, route }));
    });
    const rendered = await mapWithConcurrency(tasks, STATIC_CONCURRENCY, ({ path, route }) =>
      renderPage(route, path, () =>
        prerenderSSG(route, path.params, root, STATIC_RENDER_ORIGIN, options.basePath, searchRoutes)
      )
    );
    for (const page of rendered) {
      if ("error" in page) {
        result.renderFailures.push(page);
      } else {
        result.pages.push(page);
      }
    }
  });
  return result;
}
