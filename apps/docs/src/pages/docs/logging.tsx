import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Logging from "@/content/docs/logging.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/logging"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Logging — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={Logging}
      doc={DOCS_BY_PATH["/docs/logging"]}
      markdownSource={markdownSource}
    />
  ));
