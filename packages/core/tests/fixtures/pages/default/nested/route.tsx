import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/nested")
  .config({ mode: "ssr" })
  .layout(({ children }) => <div data-testid="nested-layout">{children}</div>);
