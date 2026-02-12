type MetaDescriptor =
  | { charSet: "utf-8" }
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string }
  | { httpEquiv: string; content: string }
  | { "script:ld+json": object }
  | { tagName: "meta" | "link"; [name: string]: string | undefined };

export interface HeadOptions {
  meta?: MetaDescriptor[];
  links?: Array<{ rel: string; href: string; [key: string]: string }>;
  scripts?: Array<{
    src?: string;
    type?: string;
    children?: string;
    [key: string]: string | undefined;
  }>;
  styles?: Array<{ type?: string; children: string }>;
}
