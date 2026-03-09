import type { Context } from "elysia";
import type { LoaderDeps, RuntimeRoute } from "../client";
import type { ResolvedRoute } from "../router";

export type LoaderResult =
  | { type: "data"; data: Record<string, unknown>; headers: Record<string, string> }
  | { type: "redirect"; response: Response };

export async function runLoaders(
  route: ResolvedRoute,
  ctx: Context,
  rootLayout: RuntimeRoute
): Promise<LoaderResult> {
  try {
    // Step 1: root loader runs first — provides global context (user, auth, etc.)
    // Root data is merged into ctxWithRoot so all subsequent loaders receive it
    // automatically (backward-compatible with the previous waterfall behaviour).
    //
    // deps is defined here so it can be passed to the root loader too.
    // The root has no ancestors, so deps always returns an empty resolved promise.
    const loaderMap = new Map<RuntimeRoute, Promise<Record<string, unknown>>>();

    const deps: LoaderDeps = (routeRef) =>
      loaderMap.get(routeRef as RuntimeRoute) ?? Promise.resolve({});

    const rootData: Record<string, unknown> = rootLayout.loader
      ? ((await rootLayout.loader({ ...ctx }, deps)) ?? {})
      : {};
    const ctxWithRoot = { ...ctx, ...rootData };

    // Step 2: launch all ancestor + page loaders immediately in parallel.
    // Each is stored in loaderMap keyed by object identity so that deps()
    // can resolve a Promise for any route in the chain.
    //
    // Loaders are inserted in chain order (index 1, 2, 3 …) so when loader N
    // calls `await deps(routeAtIndexM)` where M < N, the Promise is already
    // present in the map — no deadlock is possible for backward dependencies.

    for (let i = 1; i < route.routeChain.length; i++) {
      const ancestor = route.routeChain[i];
      if (ancestor?.loader) {
        loaderMap.set(
          ancestor,
          Promise.resolve(ancestor.loader(ctxWithRoot, deps)).then((r) => r ?? {})
        );
      }
    }

    // Page loader — all ancestors are already in the map at this point.
    const pagePromise: Promise<Record<string, unknown>> = route.page?.loader
      ? Promise.resolve(route.page.loader(ctxWithRoot, deps)).then((r) => r ?? {})
      : Promise.resolve({});

    // Step 3: await all in parallel, then flat-merge results.
    const results = await Promise.all([...loaderMap.values(), pagePromise]);
    const data = Object.assign({}, rootData, ...results);
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
