import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import LinkNavigation from "@/content/docs/link-navigation.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/link-navigation"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Link & Navigation — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={LinkNavigation}
      doc={DOCS_BY_PATH["/docs/link-navigation"]}
      markdownSource={markdownSource}
    />
  ));
