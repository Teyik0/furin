import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/(outer)/(inner)/detail")
  .config({ mode: "ssr" })
  .page(() => <p>Detail page</p>);
