import { treaty } from "@elysia/eden";
import { createIsomorphicFn } from "@teyik0/furin";
import { type Api, api as serverApi } from "@/api";

export const client = createIsomorphicFn()
  .server(() => treaty(serverApi).api)
  .client(() => treaty<Api>(window.location.origin).api)();

export const apiClient = { api: client };
