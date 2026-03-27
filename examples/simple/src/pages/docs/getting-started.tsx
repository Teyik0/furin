import { DocPage } from "@/components/doc-page";
import GettingStarted from "@/content/docs/getting-started.mdx";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Getting Started — Furin" }],
  }),
  component: () => <DocPage Content={GettingStarted} />,
});
