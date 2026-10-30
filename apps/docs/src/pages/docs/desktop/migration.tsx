import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/desktop/migration")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: DesktopMigration } = await import("@/content/docs/desktop-migration.mdx");
    const doc = DOCS_BY_PATH["/docs/desktop/migration"];
    return {
      content: await renderDocContent(DesktopMigration),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Migrating To Furin Desktop — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/desktop/migration"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
