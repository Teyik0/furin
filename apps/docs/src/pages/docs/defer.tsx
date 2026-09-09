import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Defer from "@/content/docs/defer.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/defer"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Deferred Data — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage Content={Defer} doc={DOCS_BY_PATH["/docs/defer"]} markdownSource={markdownSource} />
  ));
