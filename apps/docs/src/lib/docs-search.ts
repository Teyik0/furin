import { create, insertMultiple, search } from "@orama/orama";
import type { DocNavItem } from "./docs";
import { DOCS_CARDS } from "./docs";
import { getUniqueHeadingId } from "./docs-heading";
import {
  dedupeAndSortHits,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MIN_QUERY_LENGTH,
  type SearchHit,
  type SearchIndexEntry,
  type SearchResult,
} from "./docs-search-shared";
import { getDocSourceText } from "./docs-server";

export type { SearchIndexEntry, SearchResult } from "./docs-search-shared";

interface SearchIndexSection extends SearchIndexEntry {
  contentParts: string[];
}

const SEARCH_MAX_LIMIT = 20;
const HEADING_2_RE = /^##\s+(.+)$/;
const HEADING_3_RE = /^###\s+(.+)$/;

const searchSchema = {
  content: "string",
  description: "string",
  href: "string",
  kind: "string",
  order: "number",
  section: "string",
  title: "string",
} as const;

const searchIndexEntries = buildSearchIndexEntries();
const searchIndexPromise = buildSearchIndex(searchIndexEntries);

function stripMarkdownInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, " $1 ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, " $1 ")
    .replace(/`([^`]+)`/g, " $1 ")
    .replace(/[*_~>#-]/g, " ")
    .replace(/<\/?[\w.-]+[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/^import\s.+$/gm, "")
    .replace(/^export\s.+$/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function normalizeText(value: string): string {
  return stripMarkdownInline(value).replace(/\s+/g, " ").trim();
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) {
    return SEARCH_DEFAULT_LIMIT;
  }

  return Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit)));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: linear markdown section parser keeps heading state in one pass
export function buildSearchEntriesForDoc(doc: DocNavItem, markdown: string, orderOffset: number) {
  const normalizedMarkdown = normalizeMarkdown(markdown);
  const lines = normalizedMarkdown.split("\n");
  const headingIds = new Map<string, number>();
  const pageContentParts: string[] = [];
  const sections: SearchIndexSection[] = [];

  const pageOrder = orderOffset;
  let nextOrder = orderOffset + 1;
  let activeH2: SearchIndexSection | undefined;
  let activeH3: SearchIndexSection | undefined;

  function createSection(headingText: string): SearchIndexSection {
    const slug = getUniqueHeadingId(headingText, headingIds);
    const order = nextOrder;
    nextOrder += 1;
    const entry: SearchIndexSection = {
      content: "",
      contentParts: [],
      description: doc.description,
      href: `${doc.href}#${slug}`,
      id: `${doc.href}#${slug}`,
      kind: "section",
      order,
      section: headingText,
      title: doc.title,
    };

    sections.push(entry);

    return entry;
  }

  for (const line of lines) {
    const heading3Match = line.match(HEADING_3_RE);
    if (heading3Match) {
      const headingText = normalizeText(heading3Match[1] ?? "");
      if (headingText.length === 0) {
        continue;
      }

      activeH3 = createSection(headingText);
      continue;
    }

    const heading2Match = line.match(HEADING_2_RE);
    if (heading2Match) {
      const headingText = normalizeText(heading2Match[1] ?? "");
      if (headingText.length === 0) {
        continue;
      }

      activeH2 = createSection(headingText);
      activeH3 = undefined;
      continue;
    }

    if (line.startsWith("# ")) {
      continue;
    }

    const text = normalizeText(line);
    if (text.length === 0) {
      continue;
    }

    pageContentParts.push(text);
    if (activeH2) {
      activeH2.contentParts.push(text);
    }
    if (activeH3) {
      activeH3.contentParts.push(text);
    }
  }

  for (const section of sections) {
    section.content = section.contentParts.join(" ").trim();
  }

  const pageEntry: SearchIndexEntry = {
    content: pageContentParts.join(" ").trim(),
    description: doc.description,
    href: doc.href,
    id: `${doc.href}::page`,
    kind: "page",
    order: pageOrder,
    section: "",
    title: doc.title,
  };

  return {
    entries: [pageEntry, ...sections.map(({ contentParts: _contentParts, ...section }) => section)],
    nextOrder,
  };
}

export function buildSearchIndexEntries(): SearchIndexEntry[] {
  const entries: SearchIndexEntry[] = [];
  let order = 0;

  for (const doc of DOCS_CARDS) {
    const markdown = getDocSourceText(doc.sourcePath);
    const result = buildSearchEntriesForDoc(doc, markdown, order);

    entries.push(...result.entries);
    order = result.nextOrder;
  }

  return entries;
}

async function buildSearchIndex(entries: SearchIndexEntry[]) {
  const index = create({ schema: searchSchema });
  await insertMultiple(index, entries);
  return index;
}

export function getSearchIndexEntries(): SearchIndexEntry[] {
  return searchIndexEntries;
}

export async function searchDocs(
  rawQuery: string,
  rawLimit: number | undefined
): Promise<SearchResult[]> {
  const query = rawQuery.trim();
  if (query.length < SEARCH_MIN_QUERY_LENGTH) {
    return [];
  }

  const index = await searchIndexPromise;
  const limit = clampLimit(rawLimit);
  const response = await search(index, {
    boost: {
      content: 1,
      description: 2,
      section: 3,
      title: 5,
    },
    limit: limit * 2,
    properties: ["title", "section", "description", "content"],
    term: query,
  });

  return dedupeAndSortHits(response.hits as unknown as SearchHit[], query, limit);
}
