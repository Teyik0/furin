import { defineRoute } from "@teyik0/furin";
import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";
import { DocPage, MdxLink } from "@/components/doc-page";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .loader(async () => {
    const { default: Sync } = await import("@/content/docs/sync.mdx");
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
