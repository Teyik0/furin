import { defineRoute } from "@teyik0/furin";
import { route as parentRoute } from "../_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .layout(({ children }) => <section data-group="settings">{children}</section>);
