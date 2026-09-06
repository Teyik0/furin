import { defineRoute } from "@teyik0/furin";
import { route as nestedRoute } from "../_route";

export const route = defineRoute()
  .config({ layout: nestedRoute, mode: "ssr" })
  .layout(({ children }) => <div data-testid="deep-layout">{children}</div>);
