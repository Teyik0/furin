import { treaty } from "@elysia/eden";
import { createIsomorphicFn } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/client";
import { type Api, api as serverApi } from "../api";

// The server branch dispatches in-process: no HTTP request, no desktop session cookie.
export const api = createIsomorphicFn()
  .server(() => treaty(serverApi).use(furinSync).api)
  .client(() => treaty<Api>(window.location.origin).use(furinSync).api)();
