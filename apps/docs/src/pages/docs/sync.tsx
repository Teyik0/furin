import { defineRoute } from "@teyik0/furin";
import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";
import { DocPage, MdxLink } from "@/components/doc-page";
import Sync from "@/content/docs/sync.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .loader(async () => {
    const doc = DOCS_BY_PATH["/docs/sync"];
    const content = await createCompositeComponent<{ Link: typeof MdxLink }>(({ Link }) => (
      <Sync components={{ a: Link }} />
    ));
    return { content, markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Sync & Invalidations — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/sync"]} markdownSource={markdownSource}>
      <CompositeComponent Link={MdxLink} src={content} />
    </DocPage>
  ));
