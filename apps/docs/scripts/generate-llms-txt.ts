import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DOCS_NAV } from "../src/lib/docs";
import { stripMdxToMarkdown } from "../src/lib/strip-mdx";

const BASE_URL = "https://furin.dev";
const PROJECT_NAME = "Furin";
const PROJECT_DESCRIPTION =
  "Furin (\u98a8\u9234) is a React meta-framework built on Elysia and Bun. File-based routing, SSR/SSG/ISR, typed loaders, and SPA navigation.";
const PROJECT_LONG_DESCRIPTION =
  "Furin gives you file-based routing, nested layouts, typed data loading, and multiple rendering modes in a single Bun process.";

const DOCS_DIR = resolve(import.meta.dir, "..");
const PUBLIC_DIR = resolve(DOCS_DIR, "public");

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

  for (const section of DOCS_NAV) {
    for (const item of section.items) {
      const llmsTxtUrl = `${BASE_URL}${item.href}/llms.txt`;
      lines.push(
        `- [${item.label}](${BASE_URL}${item.href}): ${item.description} ([llms.txt](${llmsTxtUrl}))`
      );
    }
  }

  lines.push("");

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
