import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripMdxToMarkdown } from "../src/lib/strip-mdx";

const BASE_URL = "https://furin.dev";
const PROJECT_NAME = "Furin";
const PROJECT_DESCRIPTION =
  "Furin (\u98a8\u9234) is a React meta-framework built on Elysia and Bun. File-based routing, SSR/SSG/ISR, typed loaders, and SPA navigation.";
const PROJECT_LONG_DESCRIPTION =
  "Furin gives you file-based routing, nested layouts, typed data loading, and multiple rendering modes in a single Bun process.";

const DOCS_DIR = resolve(import.meta.dir, "..");
const PUBLIC_DIR = resolve(DOCS_DIR, "public");

interface NavItem {
  description: string;
  href: string;
  label: string;
  optional?: boolean;
  sourcePath: string;
}

interface NavSection {
  items: NavItem[];
  title: string;
}

const DOCS_NAV: NavSection[] = [
  {
    items: [
      {
        description: "Overview of Furin and where to go next.",
        href: "/docs",
        label: "Introduction",
        sourcePath: "src/content/docs/introduction.mdx",
      },
      {
        description: "Compare Furin with Next.js and TanStack Start across every dimension.",
        href: "/docs/comparison",
        label: "Comparison",
        sourcePath: "src/content/docs/comparison.mdx",
      },
      {
        description: "Install Furin, pick a starter, and boot your first app.",
        href: "/docs/getting-started",
        label: "Getting Started",
        sourcePath: "src/content/docs/getting-started.mdx",
      },
    ],
    title: "Getting Started",
  },
  {
    items: [
      {
        description: "How pages, params, catch-all routes, and typed links work.",
        href: "/docs/routing",
        label: "File-Based Routing",
        sourcePath: "src/content/docs/routing.mdx",
      },
      {
        description: "Server loaders, typed params/query, and data flow across routes.",
        href: "/docs/data-loading",
        label: "Data Loading",
        sourcePath: "src/content/docs/data-loading.mdx",
      },
      {
        description: "Use SSR, SSG, and ISR from defineRoute().",
        href: "/docs/rendering",
        label: "Rendering Modes",
        sourcePath: "src/content/docs/rendering.mdx",
      },
      {
        description: "Compose shared UI and loaders with _route.tsx files.",
        href: "/docs/layouts",
        label: "Nested Layouts",
        sourcePath: "src/content/docs/layouts.mdx",
      },
    ],
    title: "Core Concepts",
  },
  {
    items: [
      {
        description: "Run Elysia API routes alongside your pages in one process.",
        href: "/docs/api-routes",
        label: "API Routes",
        sourcePath: "src/content/docs/api-routes.mdx",
      },
      {
        description: "Pass Bun plugins through Furin for assets and transforms.",
        href: "/docs/plugins",
        label: "Plugins",
        sourcePath: "src/content/docs/plugins.mdx",
      },
      {
        description: "Build for Bun today, with planned targets called out clearly.",
        href: "/docs/deployment",
        label: "Deployment",
        sourcePath: "src/content/docs/deployment.mdx",
      },
    ],
    title: "Advanced",
  },
  {
    items: [
      {
        description: "How Bun HMR and Furin SSR stay aligned in development.",
        href: "/docs/dev-hmr",
        label: "Dev Mode HMR",
        optional: true,
        sourcePath: "src/content/docs/dev-hmr.mdx",
      },
    ],
    title: "Internal",
  },
];

// ---------------------------------------------------------------------------
// Read a content file
// ---------------------------------------------------------------------------

function readContentFile(sourcePath: string): string {
  const fullPath = resolve(DOCS_DIR, sourcePath);
  return readFileSync(fullPath, "utf8");
}

// ---------------------------------------------------------------------------
// Generate llms.txt (index)
// ---------------------------------------------------------------------------

function generateLlmsTxt(): string {
  const lines: string[] = [];

  lines.push(`# ${PROJECT_NAME}`);
  lines.push("");
  lines.push(`> ${PROJECT_DESCRIPTION}`);
  lines.push("");
  lines.push(PROJECT_LONG_DESCRIPTION);
  lines.push("");

  // Main docs section
  lines.push("## Docs");
  lines.push("");

  const optionalItems: NavItem[] = [];

  for (const section of DOCS_NAV) {
    for (const item of section.items) {
      if (item.optional) {
        optionalItems.push(item);
        continue;
      }
      const llmsTxtUrl = `${BASE_URL}${item.href}/llms.txt`;
      lines.push(
        `- [${item.label}](${BASE_URL}${item.href}): ${item.description} ([llms.txt](${llmsTxtUrl}))`
      );
    }
  }

  lines.push("");

  // Optional section
  lines.push("## Optional");
  lines.push("");
  for (const item of optionalItems) {
    const llmsTxtUrl = `${BASE_URL}${item.href}/llms.txt`;
    lines.push(
      `- [${item.label}](${BASE_URL}${item.href}): ${item.description} ([llms.txt](${llmsTxtUrl}))`
    );
  }
  lines.push(
    `- [Full documentation](${BASE_URL}/llms-full.txt): Complete documentation in a single file.`
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Generate llms-full.txt (complete docs)
// ---------------------------------------------------------------------------

function generateLlmsFullTxt(): string {
  const lines: string[] = [];

  lines.push(`# ${PROJECT_NAME} \u2014 Complete Documentation`);
  lines.push("");
  lines.push(`> ${PROJECT_DESCRIPTION}`);
  lines.push("");

  for (const section of DOCS_NAV) {
    for (const item of section.items) {
      const raw = readContentFile(item.sourcePath);
      const clean = stripMdxToMarkdown(raw);

      lines.push("---");
      lines.push("");
      lines.push(clean);
      lines.push("");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

mkdirSync(PUBLIC_DIR, { recursive: true });

const llmsTxt = generateLlmsTxt();
const llmsFullTxt = generateLlmsFullTxt();

writeFileSync(resolve(PUBLIC_DIR, "llms.txt"), llmsTxt, "utf8");
writeFileSync(resolve(PUBLIC_DIR, "llms-full.txt"), llmsFullTxt, "utf8");

console.log(`\u2713 public/llms.txt      (${llmsTxt.length} bytes)`);
console.log(`\u2713 public/llms-full.txt  (${llmsFullTxt.length} bytes)`);
