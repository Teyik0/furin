import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/ssr-page")
  .config({ mode: "ssr" })
  .page(() => <div data-testid="ssr-page">SSR Page</div>);
