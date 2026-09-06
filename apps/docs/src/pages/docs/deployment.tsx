import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Deployment from "@/content/docs/deployment.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/deployment"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Deployment — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={Deployment}
      doc={DOCS_BY_PATH["/docs/deployment"]}
      markdownSource={markdownSource}
    />
  ));
