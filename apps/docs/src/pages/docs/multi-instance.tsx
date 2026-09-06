import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import MultiInstance from "@/content/docs/multi-instance.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/multi-instance"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Multi-Instance & Micro-Frontends — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={MultiInstance}
      doc={DOCS_BY_PATH["/docs/multi-instance"]}
      markdownSource={markdownSource}
    />
  ));
