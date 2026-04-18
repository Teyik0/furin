import { route as rootRoute } from "./root";

// Explicit SSR mode — cannot be statically exported
export default rootRoute.page({
  loader: async () => ({ user: "Alice" }),
  mode: "ssr",
  component: ({ user }: { user: string }) => <main>Dashboard for {user}</main>,
});
