import { DocPage } from "@/components/doc-page";
import ApiRoutes from "@/content/docs/api-routes.mdx";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "API Routes — Furin" }],
  }),
  component: () => <DocPage Content={ApiRoutes} />,
});
