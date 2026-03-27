import { DocPage } from "@/components/doc-page";
import Rendering from "@/content/docs/rendering.mdx";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Rendering Modes — Furin" }],
  }),
  component: () => <DocPage Content={Rendering} />,
});
