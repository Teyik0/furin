import { DocPage } from "@/components/doc-page";
import Plugins from "@/content/docs/plugins.mdx";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Plugins — Furin" }],
  }),
  component: () => <DocPage Content={Plugins} />,
});
