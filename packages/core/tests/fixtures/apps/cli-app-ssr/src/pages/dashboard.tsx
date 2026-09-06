import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

// Explicit SSR mode — cannot be statically exported
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(async () => ({ user: "Alice" }))
  .page(({ data: { user } }) => <main>Dashboard for {user}</main>);
