import type { Context } from "elysia";
import type { RuntimeData } from "../../client/internal/runtime-types.ts";
import type { RequestLoaderContext } from "../../define-route.ts";
import { getLogger } from "../context-logger.ts";
import type { ResolvedRoute } from "../router/types.ts";
import { captureQueryReads } from "../sync/query-context.ts";
import { assertPublicLoaderKey } from "./loader-segments.ts";
import type { LoaderResult } from "./loaders.ts";
import { observeLoader } from "./observe-loader.ts";

function assertRequestLoaderKey(key: string, ctx: Context): void {
  assertPublicLoaderKey(key);
  if (
    key === "log" ||
    Object.hasOwn(ctx, key) ||
    (key in ctx && !Object.hasOwn(Object.prototype, key))
  ) {
    throw new Error(
      `[furin] requestLoader data key "${key}" is reserved: it is overwritten by the SSR loader context. Rename this field to avoid conflicts.`
    );
  }
}

function createRequestLoaderContext(ctx: Context): RequestLoaderContext {
  const headers = new Headers(ctx.request.headers);
  return Object.freeze({
    cookies: Object.freeze({
      get(name: string): unknown {
        const value = ctx.cookie?.[name]?.value;
        if (value !== undefined) {
          return value;
        }
        for (const part of headers.get("cookie")?.split(";") ?? []) {
          const separator = part.indexOf("=");
          if (separator < 0 || part.slice(0, separator).trim() !== name) {
            continue;
          }
          const raw = part.slice(separator + 1).trim();
          const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
          try {
            return decodeURIComponent(unquoted);
          } catch {
            return unquoted;
          }
        }
        return undefined;
      },
    }),
    headers: Object.freeze({
      entries: () => headers.entries(),
      get: (name: string) => headers.get(name),
      has: (name: string) => headers.has(name),
    }),
    log: getLogger(),
    params: ctx.params,
    path: ctx.path,
    query: ctx.query,
    request: ctx.request,
  });
}

function requestLoaderIndexes(route: ResolvedRoute): number[] {
  return route.routeChain.flatMap((entry, index) => (entry.requestLoader ? [index] : []));
}

/** Request field names declared by each route-chain entry, in chain order. */
export function requestKeysBySegment(route: ResolvedRoute): string[][] | undefined {
  const loaderIndexes = requestLoaderIndexes(route);
  if (route.requestKeysByLoader !== undefined || loaderIndexes.length !== 1) {
    return route.requestKeysByLoader;
  }
  return route.routeChain.map((_, index) =>
    index === loaderIndexes[0] ? (route.requestKeys ?? []) : []
  );
}

export function runRequestLoaderFields(
  route: ResolvedRoute,
  ctx: Context
):
  | {
      fields: Record<string, Promise<unknown>>;
      fieldsByLoader: Record<string, Promise<unknown>>[];
      noFieldCompletion: Promise<void>;
      resultsByLoader: (Promise<RuntimeData> | undefined)[];
    }
  | undefined {
  const loaderIndexes = requestLoaderIndexes(route);
  if (loaderIndexes.length === 0) {
    return;
  }
  if (route.requestKeys === undefined) {
    throw new Error(`[furin] Missing requestLoader field metadata for ${route.pattern}.`);
  }
  const declarations = requestKeysBySegment(route);
  if (declarations?.length !== route.routeChain.length) {
    throw new Error(`[furin] Missing per-loader request field metadata for ${route.pattern}.`);
  }
  const declaredKeys = declarations.map((keys) => new Set(keys));
  const requestKeys = new Set(route.requestKeys);
  const requestContext = createRequestLoaderContext(ctx);
  const results = loaderIndexes.map((index) => {
    const loader = route.routeChain[index]?.requestLoader;
    if (!loader) {
      throw new Error(`[furin] Missing requestLoader at route index ${index}.`);
    }
    const invocation = Promise.resolve().then(() => loader(requestContext));
    const result = observeLoader(() => invocation, `request:${index}`, ctx.path).then((value) => {
      const data = value as RuntimeData;
      for (const key of Object.keys(data)) {
        assertRequestLoaderKey(key, ctx);
        if (!declaredKeys[index]?.has(key)) {
          throw new Error(
            `[furin] requestLoader in ${route.pattern} returned undeclared field "${key}".`
          );
        }
      }
      return data;
    });
    result.catch(() => {
      /* A declared field observes the rejection; empty loaders have no field to render. */
    });
    return { index, result };
  });
  let fields: Record<string, Promise<unknown>> = {};
  const fieldsByLoader = route.routeChain.map((_, boundaryIndex) => {
    fields = { ...fields };
    for (const key of declarations[boundaryIndex] ?? []) {
      if (!requestKeys.has(key)) {
        continue;
      }
      const candidates = results.filter(
        ({ index }) => index <= boundaryIndex && declaredKeys[index]?.has(key)
      );
      fields[key] = Promise.all(candidates.map(({ result }) => result)).then((values) => {
        for (let index = values.length - 1; index >= 0; index -= 1) {
          const data = values[index];
          if (data && Object.hasOwn(data, key)) {
            return data[key];
          }
        }
      });
      fields[key].catch(() => {
        /* React or the transport observes the original rejection after public loaders settle. */
      });
    }
    return fields;
  });
  for (const key of route.requestKeys) {
    if (!Object.hasOwn(fields, key)) {
      throw new Error(`[furin] No requestLoader declares field "${key}" in ${route.pattern}.`);
    }
  }
  const noFieldCompletion = Promise.all(
    results.filter(({ index }) => declarations[index]?.length === 0).map(({ result }) => result)
  ).then(() => undefined);
  noFieldCompletion.catch(() => {
    /* The caller observes this after the public loaders settle. */
  });
  const resultsByLoader = route.routeChain.map(
    (_, index) => results.find((entry) => entry.index === index)?.result
  );
  return { fields, fieldsByLoader, noFieldCompletion, resultsByLoader };
}

export function requestFieldPromises(
  route: ResolvedRoute,
  fields: Record<string, Promise<unknown>>,
  syncData: RuntimeData,
  publicDeferred: Record<string, Promise<unknown>> | undefined
): Record<string, Promise<unknown>> {
  for (const key of Object.keys(fields)) {
    if (Object.hasOwn(syncData, key) || Object.hasOwn(publicDeferred ?? {}, key)) {
      throw new Error(
        `[furin] requestLoader field "${key}" collides with public loader data in ${route.pattern}.`
      );
    }
  }
  return fields;
}

export function withRequestLoaderData(
  route: ResolvedRoute,
  ctx: Context,
  publicResult: Extract<LoaderResult, { type: "data" }>
): Promise<Extract<LoaderResult, { type: "data" }>> {
  return captureQueryReads(
    ctx,
    async () => {
      const requestFields = runRequestLoaderFields(route, ctx);
      if (requestFields === undefined) {
        throw new Error(
          "[furin] internal invariant: requestLoader data requested for a route without requestLoader"
        );
      }
      await requestFields.noFieldCompletion;
      return {
        ...publicResult,
        deferredPromises: {
          ...(publicResult.deferredPromises ?? {}),
          ...requestFieldPromises(
            route,
            requestFields.fields,
            publicResult.syncData,
            publicResult.deferredPromises
          ),
        },
      };
    },
    "eden-request-queries"
  );
}

export function hasRequestLoader(route: ResolvedRoute): boolean {
  return route.routeChain.some((entry) => entry.requestLoader !== undefined);
}
