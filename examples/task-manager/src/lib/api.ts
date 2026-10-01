import { createIsomorphicFn } from "@teyik0/furin";
import { createClient } from "@teyik0/furin/client";
import type { Api } from "@/api";

export const api = createIsomorphicFn()
  .server(
    () =>
      createClient<Api>("http://localhost", {
        fetcher: (async (input, init) => {
          const { default: app } = await import("@/server");
          return app.handle(new Request(input, init));
        }) as typeof fetch,
        retry: 2,
      }).api
  )
  .client(() => createClient<Api>(window.location.origin, { retry: 2 }).api)();
