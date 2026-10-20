import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/")
  .config({ mode: "ssr" })
  .loader(() => ({ marker: "underscore-index" }))
  .page(({ marker }) => marker);
