import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/(admin)")
  .config({ mode: "ssr" })
  .loader(() => ({ group: "admin" }))
  .layout(({ children }) => <section data-group="admin">{children}</section>);
