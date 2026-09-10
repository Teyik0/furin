import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Sync from "@/content/docs/sync.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/sync"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Sync & Invalidations — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage Content={Sync} doc={DOCS_BY_PATH["/docs/sync"]} markdownSource={markdownSource} />
  ));
