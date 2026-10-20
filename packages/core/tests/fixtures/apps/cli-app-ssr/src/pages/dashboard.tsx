import { defineRoute } from "@teyik0/furin";

// Explicit SSR mode — cannot be statically exported
export const route = defineRoute("/dashboard")
  .config({ mode: "ssr" })
  .loader(async () => ({ user: "Alice" }))
  .page(({ user }) => <main>Dashboard for {user}</main>);
