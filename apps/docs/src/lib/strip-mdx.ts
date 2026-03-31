/**
 * Strip MDX-specific syntax from content, keeping pure Markdown.
 *
 * - Removes top-level import/export statements (outside code blocks)
 * - Converts <CodeTabs>/<CodeTab title="..."> wrappers into bold labels
 * - Removes self-closing JSX tags like <Component />
 */
const IMPORT_RE = /^import\s+/;
const EXPORT_RE = /^export\s+/;
const CODE_TAB_RE = /<CodeTab\s+title="([^"]+)"\s*>/;
const CODE_TABS_RE = /^\s*<\/?CodeTabs?\s*\/?>/;
const JSX_SELF_CLOSING_RE = /^\s*<[A-Z][a-zA-Z]*\s[^>]*\/>\s*$/;

export function stripMdxToMarkdown(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Track code block boundaries
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    // Inside code blocks, keep everything as-is
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    // Skip top-level import lines
    if (IMPORT_RE.test(line.trim())) {
      continue;
    }

    // Skip export lines
    if (EXPORT_RE.test(line.trim())) {
      continue;
    }

    // Convert <CodeTab title="..."> to a bold label
    const codeTabMatch = line.match(CODE_TAB_RE);
    if (codeTabMatch) {
      result.push(`**${codeTabMatch[1]}:**`);
      continue;
    }

    // Skip <CodeTabs>, </CodeTabs>, </CodeTab>
    if (CODE_TABS_RE.test(line)) {
      continue;
    }

    // Skip standalone JSX component lines (self-closing or open/close)
    // but only if they're not inside prose (i.e., the line is just the tag)
    if (JSX_SELF_CLOSING_RE.test(line)) {
      continue;
    }

    result.push(line);
  }

  // Clean up excessive blank lines (3+ → 2)
  return result
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
