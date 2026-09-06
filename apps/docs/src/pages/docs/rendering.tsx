import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Rendering from "@/content/docs/rendering.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/rendering"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Rendering Modes — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={Rendering}
      doc={DOCS_BY_PATH["/docs/rendering"]}
      markdownSource={markdownSource}
    />
  ));
