import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Plugins from "@/content/docs/plugins.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/plugins"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Plugins — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={Plugins}
      doc={DOCS_BY_PATH["/docs/plugins"]}
      markdownSource={markdownSource}
    />
  ));
