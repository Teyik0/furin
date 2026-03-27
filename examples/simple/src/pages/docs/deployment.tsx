import { DocPage } from "@/components/doc-page";
import Deployment from "@/content/docs/deployment.mdx";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Deployment — Furin" }],
  }),
  component: () => <DocPage Content={Deployment} />,
});
