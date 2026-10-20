import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/_route")
  .config({ mode: "ssr" })
  .loader(() => ({ user: "teyik" }))
  .layout(({ children }) => children);
