import { readFileSync } from "node:fs";
import type { RouteManifest } from "@teyik0/furin/link";
import { DOCS_CONTENT } from "../generated/docs-content";

export type OpenInTarget = "github" | "chatgpt" | "claude" | "cursor" | "copilot";

export interface DocNavItem {
  description: string;
  githubPath: string;
  href: keyof RouteManifest;
  label: string;
  openIn: OpenInTarget[];
  sourcePath: string;
  title: string;
}

export interface DocNavSection {
  items: DocNavItem[];
  title: string;
}

const DEFAULT_OPEN_IN: OpenInTarget[] = ["github", "chatgpt", "claude", "cursor", "copilot"];
const SOURCE_PREFIX_RE = /^src\//;

export const DOCS_NAV: DocNavSection[] = [
  {
    title: "Getting Started",
    items: [
      {
        label: "Introduction",
        title: "Documentation",
        href: "/docs",
        description: "Overview of Furin and where to go next.",
        sourcePath: "src/content/docs/introduction.mdx",
        githubPath: "apps/docs/src/content/docs/introduction.mdx",
        openIn: DEFAULT_OPEN_IN,
      },
      {
        label: "Getting Started",
        title: "Getting Started",
        href: "/docs/getting-started",
        description: "Install Furin, pick a starter, and boot your first app.",
        sourcePath: "src/content/docs/getting-started.mdx",
        githubPath: "apps/docs/src/content/docs/getting-started.mdx",
        openIn: DEFAULT_OPEN_IN,
      },
    ],
  },
  {
    title: "Core Concepts",
    items: [
      {
        label: "File-Based Routing",
        title: "File-Based Routing",
        href: "/docs/routing",
        description: "How pages, params, catch-all routes, and typed links work.",
        sourcePath: "src/content/docs/routing.mdx",
        githubPath: "apps/docs/src/content/docs/routing.mdx",
        openIn: DEFAULT_OPEN_IN,
      },
      {
        label: "Data Loading",
        title: "Data Loading",
        href: "/docs/data-loading",
        description: "Server loaders, typed params/query, and data flow across routes.",
        sourcePath: "src/content/docs/data-loading.mdx",
        githubPath: "apps/docs/src/content/docs/data-loading.mdx",
        openIn: DEFAULT_OPEN_IN,
      },
      {
        label: "Rendering Modes",
        title: "Rendering Modes",
        href: "/docs/rendering",
        description: "Use SSR, SSG, and ISR from createRoute().",
        sourcePath: "src/content/docs/rendering.mdx",
        githubPath: "apps/docs/src/content/docs/rendering.mdx",
        openIn: DEFAULT_OPEN_IN,
      },
      {
        label: "Nested Layouts",
        title: "Nested Layouts",
        href: "/docs/layouts",
        description: "Compose shared UI and loaders with _route.tsx files.",
        sourcePath: "src/content/docs/layouts.mdx",
        githubPath: "apps/docs/src/content/docs/layouts.mdx",
        openIn: DEFAULT_OPEN_IN,
      },
    ],
  },
  {
    title: "Advanced",
    items: [
      {
        label: "API Routes",
        title: "API Routes",
        href: "/docs/api-routes",
        description: "Run Elysia API routes alongside your pages in one process.",
        sourcePath: "src/content/docs/api-routes.mdx",
        githubPath: "apps/docs/src/content/docs/api-routes.mdx",
        openIn: DEFAULT_OPEN_IN,
      },
      {
        label: "Plugins",
        title: "Plugins",
        href: "/docs/plugins",
        description: "Pass Bun plugins through Furin for assets and transforms.",
        sourcePath: "src/content/docs/plugins.mdx",
        githubPath: "apps/docs/src/content/docs/plugins.mdx",
        openIn: DEFAULT_OPEN_IN,
      },
      {
        label: "Caching",
        title: "Caching",
        href: "/docs/caching",
        description:
          "Cache-Control strategies, revalidatePath, ETags, and CDN purging for every deployment target.",
        sourcePath: "src/content/docs/caching.mdx",
        githubPath: "apps/docs/src/content/docs/caching.mdx",
        openIn: DEFAULT_OPEN_IN,
      },
      {
        label: "Deployment",
        title: "Deployment",
        href: "/docs/deployment",
        description: "Build for Bun today, with planned targets called out clearly.",
        sourcePath: "src/content/docs/deployment.mdx",
        githubPath: "apps/docs/src/content/docs/deployment.mdx",
        openIn: DEFAULT_OPEN_IN,
      },
    ],
  },
  {
    title: "Internal",
    items: [
      {
        label: "Dev Mode HMR",
        title: "Dev Mode HMR",
        href: "/docs/dev-hmr",
        description: "How Bun HMR and Furin SSR stay aligned in development.",
        sourcePath: "src/content/docs/dev-hmr.mdx",
        githubPath: "apps/docs/src/content/docs/dev-hmr.mdx",
        openIn: DEFAULT_OPEN_IN,
      },
    ],
  },
];

export const DOCS_CARDS = DOCS_NAV.flatMap((section) => section.items);

export const DOCS_BY_PATH = Object.fromEntries(DOCS_CARDS.map((doc) => [doc.href, doc])) as Record<
  keyof RouteManifest,
  DocNavItem
>;

export function getDocByPath(pathname: string): DocNavItem | undefined {
  return DOCS_BY_PATH[pathname as keyof RouteManifest];
}

export function getDocSourceText(sourcePath: string): string {
  // In compiled binary: DOCS_CONTENT is pre-populated at build time (generate:content)
  // In dev: DOCS_CONTENT may be empty (stub) → falls back to live filesystem read
  const pregenerated = DOCS_CONTENT[sourcePath];
  if (pregenerated) {
    return pregenerated;
  }
  return readFileSync(
    new URL(`../${sourcePath.replace(SOURCE_PREFIX_RE, "")}`, import.meta.url),
    "utf8"
  );
}

function trimPrompt(markdown: string): string {
  const prompt = [
    "Use this Furin documentation page as context.",
    "Prefer answers grounded in this exact page.",
    "",
    markdown,
  ].join("\n");

  return prompt.length > 5000 ? `${prompt.slice(0, 5000)}\n\n[truncated]` : prompt;
}

export function buildOpenInUrl(
  target: OpenInTarget,
  doc: DocNavItem,
  markdown: string
): string | null {
  const prompt = encodeURIComponent(trimPrompt(markdown));

  switch (target) {
    case "github":
      return `https://github.com/teyik0/elysion/blob/main/${doc.githubPath}`;
    case "chatgpt":
      return `https://chatgpt.com/?q=${prompt}`;
    case "claude":
      return `https://claude.ai/new?q=${prompt}`;
    case "cursor":
      return "https://cursor.com";
    case "copilot":
      return "https://github.com/copilot";
    default:
      return null;
  }
}
