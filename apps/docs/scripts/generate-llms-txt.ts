/**
 * Generate /llms.txt and /llms-full.txt for AI-friendly documentation.
 *
 * Run:  bun run scripts/generate-llms-txt.ts
 *
 * Reads DOCS_NAV from src/lib/docs.ts, reads each MDX source file,
 * strips MDX-specific syntax, and writes two files into public/.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripMdxToMarkdown } from "../src/lib/strip-mdx";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = "https://furin.dev";
const PROJECT_NAME = "Furin";
const PROJECT_DESCRIPTION =
  "Furin (\u98a8\u9234) is a React meta-framework built on Elysia and Bun. File-based routing, SSR/SSG/ISR, typed loaders, and SPA navigation.";
const PROJECT_LONG_DESCRIPTION =
  "Furin gives you file-based routing, nested layouts, typed data loading, and multiple rendering modes in a single Bun process.";

const DOCS_DIR = resolve(import.meta.dir, "..");
const PUBLIC_DIR = resolve(DOCS_DIR, "public");

// ---------------------------------------------------------------------------
// Navigation structure (mirrored from src/lib/docs.ts to avoid import issues)
// ---------------------------------------------------------------------------

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
    title: "Getting Started",
    items: [
      {
        label: "Introduction",
        href: "/docs",
        description: "Overview of Furin and where to go next.",
        sourcePath: "src/content/docs/introduction.mdx",
      },
      {
        label: "Comparison",
        href: "/docs/comparison",
        description: "Compare Furin with Next.js and TanStack Start across every dimension.",
        sourcePath: "src/content/docs/comparison.mdx",
      },
      {
        label: "Getting Started",
        href: "/docs/getting-started",
        description: "Install Furin, pick a starter, and boot your first app.",
        sourcePath: "src/content/docs/getting-started.mdx",
      },
    ],
  },
  {
    title: "Core Concepts",
    items: [
      {
        label: "File-Based Routing",
        href: "/docs/routing",
        description: "How pages, params, catch-all routes, and typed links work.",
        sourcePath: "src/content/docs/routing.mdx",
      },
      {
        label: "Data Loading",
        href: "/docs/data-loading",
        description: "Server loaders, typed params/query, and data flow across routes.",
        sourcePath: "src/content/docs/data-loading.mdx",
      },
      {
        label: "Rendering Modes",
        href: "/docs/rendering",
        description: "Use SSR, SSG, and ISR from createRoute().",
        sourcePath: "src/content/docs/rendering.mdx",
      },
      {
        label: "Nested Layouts",
        href: "/docs/layouts",
        description: "Compose shared UI and loaders with _route.tsx files.",
        sourcePath: "src/content/docs/layouts.mdx",
      },
    ],
  },
  {
    title: "Advanced",
    items: [
      {
        label: "API Routes",
        href: "/docs/api-routes",
        description: "Run Elysia API routes alongside your pages in one process.",
        sourcePath: "src/content/docs/api-routes.mdx",
      },
      {
        label: "Plugins",
        href: "/docs/plugins",
        description: "Pass Bun plugins through Furin for assets and transforms.",
        sourcePath: "src/content/docs/plugins.mdx",
      },
      {
        label: "Deployment",
        href: "/docs/deployment",
        description: "Build for Bun today, with planned targets called out clearly.",
        sourcePath: "src/content/docs/deployment.mdx",
      },
    ],
  },
  {
    title: "Internal",
    items: [
      {
        label: "Dev Mode HMR",
        href: "/docs/dev-hmr",
        description: "How Bun HMR and Furin SSR stay aligned in development.",
        sourcePath: "src/content/docs/dev-hmr.mdx",
        optional: true,
      },
    ],
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
