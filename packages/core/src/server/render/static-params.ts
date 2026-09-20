import type { Context } from "elysia";
import type {
  RuntimeData,
  RuntimeParams,
  RuntimeRoute,
  RuntimeStaticParams,
} from "../../client/internal/runtime-types.ts";
import { mapWithConcurrency } from "../../shared/utils/index.ts";
import type { ResolvedRoute } from "../router/types.ts";
import { resolvePath } from "./assemble.ts";
import { runPublicLoaders } from "./loaders.ts";

interface StaticParamsStage {
  ancestors: RuntimeRoute[];
  run: RuntimeStaticParams;
}

const STATIC_PARAMS_CONCURRENCY = 4;

function collectStaticParamsStages(route: ResolvedRoute): StaticParamsStage[] {
  const stages: StaticParamsStage[] = [];
  for (const [index, entry] of route.routeChain.entries()) {
    if (entry.staticParams) {
      stages.push({ ancestors: route.routeChain.slice(0, index), run: entry.staticParams });
    }
  }
  if (route.page.staticParams) {
    stages.push({ ancestors: route.routeChain, run: route.page.staticParams });
  }
  return stages;
}

function createBuildContext(route: ResolvedRoute, params: RuntimeParams, origin: string): Context {
  const path = resolvePath(route.pattern, params);
  return {
    cookie: {},
    headers: {},
    params,
    path,
    query: {},
    redirect: (url: string, status: number | undefined) =>
      new Response(null, { headers: { Location: url }, status: status ?? 302 }),
    request: new Request(new URL(path, origin)),
    set: { headers: {} },
  } as Context;
}

async function runAncestorLoaders(
  route: ResolvedRoute,
  ancestors: RuntimeRoute[],
  params: RuntimeParams,
  origin: string
): Promise<RuntimeData> {
  const result = await runPublicLoaders(
    {
      ...route,
      page: { ...route.page, loader: undefined },
      routeChain: ancestors,
    },
    createBuildContext(route, params, origin)
  );

  if (result.type === "redirect") {
    throw result.response;
  }
  if (result.type === "not-found") {
    throw result.error;
  }
  if (result.type === "error") {
    throw result.error;
  }

  const data: RuntimeData = {};
  for (const [key, value] of Object.entries(result.syncData)) {
    if (key !== "params" && key !== "path" && key !== "query") {
      data[key] = value;
    }
  }
  Object.assign(data, result.deferredPromises);
  return data;
}

function createStaticParamsContext(
  route: ResolvedRoute,
  ancestors: RuntimeRoute[],
  params: RuntimeParams,
  origin: string
): RuntimeData & { params: RuntimeParams } {
  const target: RuntimeData & { params: RuntimeParams } = { params };
  const fields = new Map<string, Promise<unknown>>();
  let parentData: Promise<RuntimeData> | undefined;

  return new Proxy(target, {
    get(context, property: string | symbol) {
      if (typeof property !== "string" || Object.hasOwn(context, property)) {
        return Reflect.get(context, property);
      }
      if (
        property === "then" ||
        property === "catch" ||
        property === "finally" ||
        property === "toJSON"
      ) {
        return;
      }
      let field = fields.get(property);
      if (!field) {
        parentData ??= runAncestorLoaders(route, ancestors, params, origin);
        field = parentData.then((data) => data[property]);
        fields.set(property, field);
      }
      return field;
    },
  });
}

export function hasStaticParams(route: ResolvedRoute): boolean {
  return (
    route.page.staticParams !== undefined ||
    route.routeChain.some((entry) => entry.staticParams !== undefined)
  );
}

export async function resolveStaticParams(
  route: ResolvedRoute,
  origin: string
): Promise<RuntimeParams[] | undefined> {
  const stages = collectStaticParamsStages(route);
  if (stages.length === 0) {
    return;
  }

  let branches: RuntimeParams[] = [{}];
  for (const stage of stages) {
    // Stages are dependent (parent params feed the next stage), while sibling
    // branches are independent and can run through a bounded worker pool.
    // biome-ignore lint/performance/noAwaitInLoops: each stage consumes the previous stage's params
    const branchValues = await mapWithConcurrency(
      branches,
      STATIC_PARAMS_CONCURRENCY,
      async (params) => {
        const values = await stage.run(
          createStaticParamsContext(route, stage.ancestors, params, origin)
        );
        if (!Array.isArray(values)) {
          throw new TypeError(
            `[furin] staticParams() for "${route.pattern}" must return an array.`
          );
        }
        return values.map((value) => ({ ...params, ...value }));
      }
    );
    branches = branchValues.flat();
  }
  return branches;
}
