import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";

/** Minimal Elysia context for running loaders and renders outside a server (path `/test`). */
export function createMockLoaderContext(overrides: Partial<Context>): Context {
  return {
    cookie: {},
    headers: {},
    params: {},
    path: "/test",
    query: {},
    redirect: (url: string) => new Response(null, { headers: { Location: url }, status: 302 }),
    request: new Request("http://localhost/test"),
    set: { headers: {} as HTTPHeaders },
    ...overrides,
  } as Context;
}
