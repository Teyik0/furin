import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/(admin)/(settings)")
  .config({ mode: "ssr" })
  .layout(({ children }) => <section data-group="settings">{children}</section>);
