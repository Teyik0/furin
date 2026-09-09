import type { RouteManifest } from "@teyik0/furin/link";

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

export const DOCS_NAV: DocNavSection[] = [
  {
    items: [
      {
        description: "Overview of Furin and where to go next.",
        githubPath: "apps/docs/src/content/docs/introduction.mdx",
        href: "/docs",
        label: "Introduction",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/introduction.mdx",
        title: "Documentation",
      },
      {
        description: "Compare Furin with Next.js and TanStack Start across every dimension.",
        githubPath: "apps/docs/src/content/docs/comparison.mdx",
        href: "/docs/comparison",
        label: "Comparison",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/comparison.mdx",
        title: "Next.js vs TanStack Start vs Furin",
      },
      {
        description: "Install Furin, pick a starter, and boot your first app.",
        githubPath: "apps/docs/src/content/docs/getting-started.mdx",
        href: "/docs/getting-started",
        label: "Getting Started",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/getting-started.mdx",
        title: "Getting Started",
      },
      {
        description: "Build commands, flags, and target options.",
        githubPath: "apps/docs/src/content/docs/cli.mdx",
        href: "/docs/cli",
        label: "CLI Reference",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/cli.mdx",
        title: "CLI Reference",
      },
      {
        description: "Every field in furin.config.ts explained.",
        githubPath: "apps/docs/src/content/docs/configuration.mdx",
        href: "/docs/configuration",
        label: "Configuration",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/configuration.mdx",
        title: "Configuration Reference",
      },
    ],
    title: "Getting Started",
  },
  {
    items: [
      {
        description: "How pages, params, catch-all routes, and typed links work.",
        githubPath: "apps/docs/src/content/docs/routing.mdx",
        href: "/docs/routing",
        label: "File-Based Routing",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/routing.mdx",
        title: "File-Based Routing",
      },
      {
        description: "Typed <Link>, useRouter, prefetch, and scroll management.",
        githubPath: "apps/docs/src/content/docs/link-navigation.mdx",
        href: "/docs/link-navigation",
        label: "Link & Navigation",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/link-navigation.mdx",
        title: "Link & Navigation",
      },
      {
        description: "Server loaders, typed params/query, and data flow across routes.",
        githubPath: "apps/docs/src/content/docs/data-loading.mdx",
        href: "/docs/data-loading",
        label: "Data Loading",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/data-loading.mdx",
        title: "Data Loading",
      },
      {
        description: "Stream slow data with defer() and <Await> for better perceived performance.",
        githubPath: "apps/docs/src/content/docs/defer.mdx",
        href: "/docs/defer",
        label: "Deferred Data",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/defer.mdx",
        title: "Deferred Data",
      },
      {
        description: "Use SSR, SSG, and ISR from defineRoute().",
        githubPath: "apps/docs/src/content/docs/rendering.mdx",
        href: "/docs/rendering",
        label: "Rendering Modes",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/rendering.mdx",
        title: "Rendering Modes",
      },
      {
        description: "Meta tags, Open Graph, JSON-LD, and per-page head management.",
        githubPath: "apps/docs/src/content/docs/head-seo.mdx",
        href: "/docs/head-seo",
        label: "Head & SEO",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/head-seo.mdx",
        title: "Head & SEO",
      },
      {
        description: "error.tsx, not-found.tsx, notFound(), digests, and SPA 404 handling.",
        githubPath: "apps/docs/src/content/docs/error-handling.mdx",
        href: "/docs/error-handling",
        label: "Error Handling",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/error-handling.mdx",
        title: "Error Handling",
      },
      {
        description: "Compose shared UI and loaders with _route.tsx files.",
        githubPath: "apps/docs/src/content/docs/layouts.mdx",
        href: "/docs/layouts",
        label: "Nested Layouts",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/layouts.mdx",
        title: "Nested Layouts",
      },
    ],
    title: "Core Concepts",
  },
  {
    items: [
      {
        description: "Run Elysia API routes alongside your pages in one process.",
        githubPath: "apps/docs/src/content/docs/api-routes.mdx",
        href: "/docs/api-routes",
        label: "API Routes",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/api-routes.mdx",
        title: "API Routes",
      },
      {
        description: "Pass Bun plugins through Furin for assets and transforms.",
        githubPath: "apps/docs/src/content/docs/plugins.mdx",
        href: "/docs/plugins",
        label: "Plugins",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/plugins.mdx",
        title: "Plugins",
      },
      {
        description:
          "Mount several furin apps in one server under prefixes, and package apps as prebuilt Elysia plugins.",
        githubPath: "apps/docs/src/content/docs/multi-instance.mdx",
        href: "/docs/multi-instance",
        label: "Multi-Instance",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/multi-instance.mdx",
        title: "Multi-Instance & Micro-Frontends",
      },
      {
        description:
          "Cache-Control strategies, revalidatePath, ETags, and CDN purging for every deployment target.",
        githubPath: "apps/docs/src/content/docs/caching.mdx",
        href: "/docs/caching",
        label: "Caching",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/caching.mdx",
        title: "Caching",
      },
      {
        description: "Built-in evlog integration: request logs, client-side drain, and adapters.",
        githubPath: "apps/docs/src/content/docs/logging.mdx",
        href: "/docs/logging",
        label: "Logging",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/logging.mdx",
        title: "Logging",
      },
      {
        description: "Build for Bun today, with planned targets called out clearly.",
        githubPath: "apps/docs/src/content/docs/deployment.mdx",
        href: "/docs/deployment",
        label: "Deployment",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/deployment.mdx",
        title: "Deployment",
      },
    ],
    title: "Advanced",
  },
  {
    items: [
      {
        description: "How Bun HMR and Furin SSR stay aligned in development.",
        githubPath: "apps/docs/src/content/docs/dev-hmr.mdx",
        href: "/docs/dev-hmr",
        label: "Dev Mode HMR",
        openIn: DEFAULT_OPEN_IN,
        sourcePath: "src/content/docs/dev-hmr.mdx",
        title: "Dev Mode HMR",
      },
    ],
    title: "Internal",
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
