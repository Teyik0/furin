import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Cli from "@/content/docs/cli.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/cli"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "CLI — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage Content={Cli} doc={DOCS_BY_PATH["/docs/cli"]} markdownSource={markdownSource} />
  ));
