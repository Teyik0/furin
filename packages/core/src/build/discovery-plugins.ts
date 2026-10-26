// biome-ignore-all lint/performance/noAwaitInLoops: plugin registration order determines module resolution
import type { FurinPlugin } from "../config.ts";

export type DiscoveryHook = { id: number } & (
  | { method: "module"; specifier: string }
  | {
      method: "onLoad" | "onResolve";
      filter: { source: string; flags: string };
      namespace?: string;
    }
);

export interface DiscoveryPluginRequest {
  args: Omit<Bun.OnLoadArgs, "defer"> | Bun.OnResolveArgs | undefined;
  hook: number;
  id: number;
  syncPath?: string;
}

export type DiscoveryPluginResponse =
  | { id: number; ok: true; value: Bun.OnLoadResult | Bun.OnResolveResult | null }
  | { id: number; ok: false; error: string };

/** Keep plugin closures in the caller; only module source crosses IPC. */
export async function discoveryPlugins(plugins: readonly FurinPlugin[]) {
  const hooks: DiscoveryHook[] = [];
  const callbacks: ((
    args: DiscoveryPluginRequest["args"]
  ) => Promise<Bun.OnLoadResult | Bun.OnResolveResult | null>)[] = [];
  for (const plugin of plugins) {
    if (plugin.buildOnly) {
      continue;
    }
    try {
      await Bun.plugin({
        name: plugin.name,
        setup(builder) {
          const proxy = new Proxy(builder, {
            get(target, method) {
              if (method === "onLoad" || method === "onResolve") {
                return (
                  constraints: Bun.PluginConstraints,
                  callback: Bun.OnLoadCallback | Bun.OnResolveCallback
                ) => {
                  const id = callbacks.length;
                  callbacks.push(
                    async (args) =>
                      await (callback as (input: typeof args) => ReturnType<typeof callback>)(args)
                  );
                  hooks.push({
                    id,
                    method,
                    filter: { source: constraints.filter.source, flags: constraints.filter.flags },
                    namespace: constraints.namespace,
                  });
                  return proxy;
                };
              }
              if (method === "module") {
                return (
                  specifier: string,
                  callback: () => Bun.OnLoadResult | Promise<Bun.OnLoadResult>
                ) => {
                  const id = callbacks.length;
                  callbacks.push(async () => await callback());
                  hooks.push({ id, method, specifier });
                  return proxy;
                };
              }
              const value = Reflect.get(target, method);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return plugin.setup(proxy);
        },
      });
    } catch (error) {
      throw new Error(
        `[furin] Plugin "${plugin.name}" could not be registered for server-side route imports: ${error instanceof Error ? error.message : String(error)}\n` +
          "If it only transforms the client bundle (for example bun-plugin-tailwind), mark it build-only in furin.config.ts:\n" +
          "  plugins: [{ ...plugin, buildOnly: true }]",
        { cause: error }
      );
    }
  }
  return {
    hooks,
    async respond(request: DiscoveryPluginRequest): Promise<DiscoveryPluginResponse> {
      try {
        const value = await callbacks[request.hook]?.(request.args);
        return { id: request.id, ok: true, value };
      } catch (error) {
        return {
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
