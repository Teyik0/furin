import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/nested/deep")
  .config({ mode: "ssr" })
  .layout(({ children }) => <div data-testid="deep-layout">{children}</div>);
