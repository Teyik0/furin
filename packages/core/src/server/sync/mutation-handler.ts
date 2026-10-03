import type { Context, Elysia } from "elysia";
import { createContext } from "elysia/context";

const mutationBeginnings = new WeakMap<Request, () => Promise<Response | undefined>>();
const installedApplications = new WeakSet<Elysia>();
const installedContexts = new WeakSet<object>();

export function prepareMutationHandler(
  context: Pick<Context, "request">,
  begin: () => Promise<Response | undefined>
): void {
  if (!installedContexts.has(context.constructor)) {
    throw new Error(
      "[furin] Install furinSync on the final Elysia application, or mount furin({ sync }), before using mutation routes."
    );
  }
  mutationBeginnings.set(context.request, begin);
}

/** Keep reservation and replay after authorization, including mounted route plugins. */
export function installMutationHandlers(app: Elysia): void {
  if (installedApplications.has(app)) {
    return;
  }
  installedApplications.add(app);
  app.decorate("_furinMutationHandlers", true);
  app.wrap((fetch) => {
    installedContexts.add(createContext(app));
    return fetch;
  });
  const compileHandler = app.handler.bind(app);
  app.handler = (index, immediate, route, aliases, table) => {
    // Passing the complete tuple also preserves the wrapper in Elysia's JIT path.
    const nativeRoute =
      route ??
      (table
        ? ([
            table.method[index],
            table.path[index],
            table.handler[index],
            table.owner[index],
            table.localHook[index],
            table.appHook[index],
            table.inheritedChain[index],
            table.macroScope?.get(index),
          ] as NonNullable<typeof route>)
        : app["~routes"][index]);
    if (!nativeRoute || ["GET", "HEAD", "OPTIONS", "WS"].includes(nativeRoute[0])) {
      return compileHandler(index, immediate, route, aliases, table);
    }
    const [method, path, handle, owner, hooks, chain, inherited, macroScope] = nativeRoute;
    const wrapped = async (context: Context) => {
      const begin = mutationBeginnings.get(context.request);
      mutationBeginnings.delete(context.request);
      const response = await begin?.();
      if (response !== undefined) {
        return response;
      }
      return typeof handle === "function" ? handle(context) : handle;
    };
    return compileHandler(
      index,
      immediate,
      [method, path, wrapped, owner, hooks, chain, inherited, macroScope],
      aliases,
      table
    );
  };
}
