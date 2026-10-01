import { Link } from "@teyik0/furin/link";
import type { ComponentType, ElementType } from "react";
import type { DocNavItem } from "@/lib/docs";
import { CodeTab, CodeTabs } from "./code-tabs";
import { DocsActions } from "./docs-actions";

const ABSOLUTE_URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isInternalHref(href: string | undefined): boolean {
  if (!href) {
    return false;
  }
  // Protocol-relative URLs are external
  if (href.startsWith("//")) {
    return false;
  }
  // Absolute URLs (http:, https:, mailto:, etc.) are external
  if (ABSOLUTE_URL_RE.test(href)) {
    return false;
  }
  return true;
}

export function MdxLink({
  href,
  children,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href?.startsWith("#")) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }
  if (href && isInternalHref(href)) {
    return (
      <Link to={href} {...props}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} {...props} rel="noopener noreferrer" target="_blank">
      {children}
    </a>
  );
}

const MDX_COMPONENTS = { a: MdxLink, CodeTab, CodeTabs };

type DocPageProps = {
  doc: DocNavItem;
  markdownSource: string;
} & (
  | { Content: ComponentType<{ components?: { [tag: string]: ElementType } }>; children?: never }
  | { Content?: never; children: React.ReactNode }
);

export function DocPage({ Content, children, doc, markdownSource }: DocPageProps) {
  const content = Content ? <Content components={MDX_COMPONENTS} /> : children;
  return (
    <article
      className="doc-content prose prose-slate dark:prose-invert max-w-none"
      id="doc-content"
    >
      <DocsActions doc={doc} markdownSource={markdownSource} />
      {content}
    </article>
  );
}
