import { defineRootRoute } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .loader(() => ({ root: true }))
  .layout(({ children }) => children);
