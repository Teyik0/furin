import type { RuntimeRoute } from "../client";
import type { ResolvedRoute } from "../router";
import type { LoaderContext } from "./assemble";

export type LoaderResult =
  | { type: "data"; data: Record<string, unknown>; headers: Record<string, string> }
  | { type: "redirect"; response: Response };

export async function runLoaders(
  route: ResolvedRoute,
  ctx: LoaderContext,
  rootLayout: RuntimeRoute | null
): Promise<LoaderResult> {
  let data: Record<string, unknown> = {};
  const headers: Record<string, string> = {};

  try {
    if (rootLayout?.loader) {
      const result = await rootLayout.loader({ ...ctx, ...data });
      data = { ...data, ...result };
      Object.assign(headers, ctx.set.headers);
    }

    for (let i = 1; i < route.routeChain.length; i++) {
      const ancestor = route.routeChain[i];
      if (ancestor?.loader) {
        const result = await ancestor.loader({ ...ctx, ...data });
        data = { ...data, ...result };
        Object.assign(headers, ctx.set.headers);
      }
    }

    if (route.page?.loader) {
      const result = await route.page.loader({ ...ctx, ...data });
      data = { ...data, ...result };
      Object.assign(headers, ctx.set.headers);
    }

    return { type: "data", data, headers };
  } catch (err) {
    if (err instanceof Response) {
      return { type: "redirect", response: err };
    }
    throw err;
  }
}
