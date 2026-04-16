import type { Context } from "elysia";
import type { RuntimeRoute } from "../client";
import type { ResolvedRoute } from "../router";

export type LoaderResult =
  | { type: "data"; data: Record<string, unknown>; headers: Record<string, string> }
  | { type: "redirect"; response: Response };

/**
 * Wraps the Elysia context so that any property NOT present on `ctx` is
 * returned as an individual `Promise<value>` resolved from the accumulated
 * parent data. Properties that ARE present on `ctx` (request, params, set, …)
 * are returned as-is.
 *
 * A per-prop cache ensures the same Promise instance is returned on repeated
 * access of the same field (stable reference for Promise.all etc.).
 */
function createLoaderCtx(
  ctx: Record<string, unknown>,
  accumulatedParentPromise: Promise<Record<string, unknown>>
): Record<string, unknown> {
  const cache = new Map<string, Promise<unknown>>();
  return new Proxy(ctx, {
    get(target, prop: string | symbol) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop);
      }
      // RouteContext fields (request, params, query, set, headers, cookie,
      // path, redirect) are present on target — return directly.
      if (prop in target) {
        return target[prop];
      }
      // Everything else is a parent-data field → individual lazy Promise.
      let entry = cache.get(prop);
      if (!entry) {
        entry = accumulatedParentPromise.then((data) => data[prop]);
        cache.set(prop, entry);
      }
      return entry;
    },
  });
}

export async function runLoaders(
  route: ResolvedRoute,
  ctx: Context,
  // kept for API compat; routeChain[0] is the root layout
  _rootLayout: RuntimeRoute
): Promise<LoaderResult> {
  try {
    const loaderMap = new Map<RuntimeRoute, Promise<Record<string, unknown>>>();

    // All loaders in the chain start immediately. Each receives a Proxy where
    // parent-data fields are individually-awaitable Promises. The loader opts
    // in to waiting by doing `await user` (or `Promise.all([user, org])`);
    // if it never awaits a parent field it runs in full parallel.
    let accumulatedParentPromise: Promise<Record<string, unknown>> = Promise.resolve({});

    for (const r of route.routeChain) {
      const parentAccum = accumulatedParentPromise; // capture for closure

      if (r.loader) {
        const loaderCtx = createLoaderCtx(ctx as Record<string, unknown>, parentAccum);
        const loaderPromise = Promise.resolve(r.loader(loaderCtx)).then((res) => res ?? {});
        loaderMap.set(r, loaderPromise);

        // Accumulate: previous ancestors + this loader's result.
        accumulatedParentPromise = Promise.all([parentAccum, loaderPromise]).then(([acc, own]) => ({
          ...acc,
          ...own,
        }));
      }
    }

    // Page loader receives all route-chain fields as individual Promises.
    const pageCtx = createLoaderCtx(ctx as Record<string, unknown>, accumulatedParentPromise);
    const pagePromise: Promise<Record<string, unknown>> = route.page?.loader
      ? Promise.resolve(route.page.loader(pageCtx)).then((r) => r ?? {})
      : Promise.resolve({});

    // Await everything in parallel, then flat-merge (same contract as before).
    const results = await Promise.all([...loaderMap.values(), pagePromise]);
    const data = Object.assign({}, ...results);
    const headers: Record<string, string> = {};
    Object.assign(headers, ctx.set.headers);

    return { type: "data", data, headers };
  } catch (err) {
    if (err instanceof Response) {
      return { type: "redirect", response: err };
    }
    throw err;
  }
}
