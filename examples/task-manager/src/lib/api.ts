import { createIsomorphicFn } from "@teyik0/furin";
import { createClient } from "@teyik0/furin/client";
import { type Api, api as serverApi } from "@/api";

export const api = createIsomorphicFn()
  .server(() => createClient(serverApi, { retry: 2 }).api)
  .client(() => createClient<Api>(window.location.origin, { retry: 2 }).api)();
