import type { ComponentType } from "react";
import type { DocNavItem } from "@/lib/docs";
import { CodeTab, CodeTabs } from "./code-tabs";
import { DocsActions } from "./docs-actions";

const MDX_COMPONENTS = { CodeTabs, CodeTab };

interface DocPageProps {
  Content: ComponentType<{ components?: Record<string, unknown> }>;
  doc: DocNavItem;
  markdownSource: string;
}

export function DocPage({ Content, doc, markdownSource }: DocPageProps) {
  return (
    <article
      className="doc-content prose prose-slate dark:prose-invert max-w-none"
      id="doc-content"
    >
      <DocsActions doc={doc} markdownSource={markdownSource} />
      <Content components={MDX_COMPONENTS} />
    </article>
  );
}
