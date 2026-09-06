import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Caching from "@/content/docs/caching.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/caching"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Caching — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={Caching}
      doc={DOCS_BY_PATH["/docs/caching"]}
      markdownSource={markdownSource}
    />
  ));
