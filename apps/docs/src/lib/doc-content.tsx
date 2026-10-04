import { createCompositeComponent } from "@teyik0/furin/rsc";
import type { ComponentType, ElementType } from "react";
import type { DocContentSlots } from "@/components/doc-content";

export function renderDocContent(
  Content: ComponentType<{ components?: { [tag: string]: ElementType } }>
) {
  return createCompositeComponent<DocContentSlots>(({ CodeTab, CodeTabs, Link }) => (
    <Content components={{ a: Link, CodeTab, CodeTabs }} />
  ));
}
