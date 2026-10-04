import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(() => ({ group: "marketing" }))
  .layout(({ children }) => <section data-group="marketing">{children}</section>);
