import { DocPage } from "@/components/doc-page";
import Routing from "@/content/docs/routing.mdx";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "File-Based Routing — Furin" }],
  }),
  component: () => <DocPage Content={Routing} />,
});
