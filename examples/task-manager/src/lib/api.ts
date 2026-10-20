import { treaty } from "@elysia/eden";
import { createIsomorphicFn } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/client";
import { type Api, api as serverApi } from "@/api";

export const api = createIsomorphicFn()
  .server(() => treaty(serverApi).use(furinSync).api)
  .client(() => treaty<Api>(window.location.origin).use(furinSync).api)();
