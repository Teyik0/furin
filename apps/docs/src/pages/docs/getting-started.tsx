import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import GettingStarted from "@/content/docs/getting-started.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/getting-started"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Getting Started — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={GettingStarted}
      doc={DOCS_BY_PATH["/docs/getting-started"]}
      markdownSource={markdownSource}
    />
  ));
