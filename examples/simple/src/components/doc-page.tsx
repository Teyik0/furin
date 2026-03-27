import type { ComponentType } from "react";
import { CodeTab, CodeTabs } from "./code-tabs";

const MDX_COMPONENTS = { CodeTabs, CodeTab };

interface DocPageProps {
  Content: ComponentType<{ components?: Record<string, unknown> }>;
}

export function DocPage({ Content }: DocPageProps) {
  return (
    <article className="prose prose-slate dark:prose-invert max-w-none">
      <Content components={MDX_COMPONENTS} />
    </article>
  );
}
