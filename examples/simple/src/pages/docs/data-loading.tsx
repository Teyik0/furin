import { DocPage } from "@/components/doc-page";
import DataLoading from "@/content/docs/data-loading.mdx";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Data Loading — Furin" }],
  }),
  component: () => <DocPage Content={DataLoading} />,
});
