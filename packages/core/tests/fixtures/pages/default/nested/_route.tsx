import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .layout(({ children }) => <div data-testid="nested-layout">{children}</div>);
