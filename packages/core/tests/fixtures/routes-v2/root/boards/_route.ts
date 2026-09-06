import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../_route";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(() => ({ user: "teyik" }))
  .layout(({ children }) => children);
