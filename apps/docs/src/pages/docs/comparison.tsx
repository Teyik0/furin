import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Comparison from "@/content/docs/comparison.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/comparison"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Next.js vs TanStack Start vs Furin — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={Comparison}
      doc={DOCS_BY_PATH["/docs/comparison"]}
      markdownSource={markdownSource}
    />
  ));
