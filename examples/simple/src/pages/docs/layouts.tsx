import { DocPage } from "@/components/doc-page";
import Layouts from "@/content/docs/layouts.mdx";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Nested Layouts — Furin" }],
  }),
  component: () => <DocPage Content={Layouts} />,
});
