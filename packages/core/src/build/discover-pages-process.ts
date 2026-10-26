// biome-ignore-all lint/performance/noAwaitInLoops: share one module graph across mounts, then exit before AOT
// Discovery observes the same resource guard as AOT, without capturing handlers.
import "elysia/plugin/aot/unplugin";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { deserialize } from "node:v8";
import { snapshotRouteRegistry } from "../plugin/route-registry.ts";
import type { RouteInstanceSpec } from "../plugin/route-tree.ts";
import {
  isomorphicTransformPlugin,
  transformIsomorphicFunctions,
} from "../plugin/transform-isomorphic.ts";
import { detectLoaderFromPath } from "../server/lang-detect.ts";
import { scanPages } from "../server/router/discovery.ts";
import type { DiscoveredApp } from "./discover-pages.ts";
import { discoveryModule, discoveryModuleFilter } from "./discovery-module.ts";
import type {
  DiscoveryHook,
  DiscoveryPluginRequest,
  DiscoveryPluginResponse,
} from "./discovery-plugins.ts";
import { buildRouteMetadata, rootHasRequestLoader } from "./route-metadata.ts";

const { apps, hooks, resultPath } = JSON.parse(process.argv[2] as string) as {
  apps: RouteInstanceSpec[];
  hooks: DiscoveryHook[];
  resultPath: string;
};
let nextId = 0;
const pending = new Map<
  number,
  {
    resolve: (value: Bun.OnLoadResult | Bun.OnResolveResult | null) => void;
    reject: (error: Error) => void;
  }
>();
process.on("message", (response: DiscoveryPluginResponse) => {
  const request = pending.get(response.id);
  pending.delete(response.id);
  if (response.ok) {
    request?.resolve(response.value);
  } else {
    request?.reject(new Error(response.error));
  }
});
function invoke(hook: number, args: DiscoveryPluginRequest["args"]) {
  const id = nextId;
  nextId += 1;
  return new Promise<Bun.OnLoadResult | Bun.OnResolveResult | null>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Runtime callbacks have no bundler defer function; copy only IPC-safe arguments.
    const payload = args && "defer" in args ? { ...args, defer: undefined } : args;
    process.send?.({ hook, id, args: payload } satisfies DiscoveryPluginRequest);
  });
}
// Bun's runtime onResolve cannot return a pending promise. Keep that callback
// synchronous while the parent executes the original closure in its own heap.
function resolveImport(hook: number, args: Bun.OnResolveArgs): Bun.OnResolveResult | undefined {
  const id = nextId;
  nextId += 1;
  const syncPath = join(dirname(resultPath), `resolve-${id}.bin`);
  process.send?.({ hook, id, args, syncPath } satisfies DiscoveryPluginRequest);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 30_000;
  while (!existsSync(syncPath)) {
    if (Date.now() >= deadline) {
      throw new Error(`[furin] Discovery plugin timed out resolving ${args.path}.`);
    }
    Atomics.wait(wait, 0, 0, 1);
  }
  const response = deserialize(readFileSync(syncPath)) as DiscoveryPluginResponse;
  unlinkSync(syncPath);
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.value as Bun.OnResolveResult | undefined;
}
const metadataFilter = discoveryModuleFilter(apps.map((app) => app.pagesDir));

function isolateModule(result: Bun.OnLoadResult, path: string): Bun.OnLoadResult {
  if (!result || result.loader === "object" || !metadataFilter.test(path)) {
    return result;
  }
  const loader = result.loader ?? detectLoaderFromPath(path);
  if (!(loader === "js" || loader === "jsx" || loader === "ts" || loader === "tsx")) {
    return result;
  }
  const code =
    typeof result.contents === "string"
      ? result.contents
      : new TextDecoder().decode(result.contents);
  const sourcePath = `${path}.${loader}`;
  const contents = discoveryModule(code, path, loader);
  return { ...result, contents: transformIsomorphicFunctions(contents, sourcePath, "server").code };
}
Bun.plugin({
  name: "furin-discovery-plugins",
  setup(builder) {
    for (const hook of hooks) {
      if (hook.method === "module") {
        builder.module(
          hook.specifier,
          () => invoke(hook.id, undefined) as Promise<Bun.OnLoadResult>
        );
        continue;
      }
      const constraints = {
        filter: new RegExp(hook.filter.source, hook.filter.flags),
        namespace: hook.namespace,
      };
      if (hook.method === "onLoad") {
        builder.onLoad(constraints, async (args) =>
          isolateModule((await invoke(hook.id, args)) as Bun.OnLoadResult, args.path)
        );
      } else {
        builder.onResolve(constraints, (args) => resolveImport(hook.id, args));
      }
    }
  },
});
Bun.plugin({
  name: "furin-route-metadata",
  setup(builder) {
    builder.onLoad({ filter: metadataFilter }, async ({ path }) =>
      isolateModule(
        { contents: await Bun.file(path).text(), loader: detectLoaderFromPath(path) },
        path
      )
    );
  },
});
Bun.plugin(isomorphicTransformPlugin("server"));

const discovered: DiscoveredApp[] = [];
process.env.ELYSIA_AOT_BUILD = "1";
for (const spec of apps) {
  const { root, routes } = await scanPages(spec.pagesDir);
  discovered.push({
    ...spec,
    routeRegistry: await snapshotRouteRegistry(spec),
    root: {
      path: root.path,
      errorPath: root.errorPath,
      notFoundPath: root.notFoundPath,
      hasRequestLoader: rootHasRequestLoader(root),
    },
    routes: routes.map(buildRouteMetadata),
  });
}
await Bun.write(resultPath, JSON.stringify(discovered));
process.exit(0);
