import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/boards")
  .config({ mode: "ssr" })
  .loader(() => ({ user: "teyik" }))
  .layout(({ children }) => children);
