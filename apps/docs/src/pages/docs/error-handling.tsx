import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import ErrorHandling from "@/content/docs/error-handling.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/error-handling"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Error Handling — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={ErrorHandling}
      doc={DOCS_BY_PATH["/docs/error-handling"]}
      markdownSource={markdownSource}
    />
  ));
