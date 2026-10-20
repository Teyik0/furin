import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/(marketing)/_route")
  .config({ mode: "ssr" })
  .loader(() => ({ group: "marketing" }))
  .layout(({ children }) => <section data-group="marketing">{children}</section>);
