import { create, insertMultiple, search } from "@orama/orama";
import type { DocNavItem } from "./docs";
import { DOCS_CARDS, getDocSourceText } from "./docs";
import { getUniqueHeadingId } from "./docs-heading";

export interface SearchIndexEntry {
  content: string;
  description: string;
  href: string;
  id: string;
  kind: "page" | "section";
  order: number;
  section: string;
  title: string;
}

export interface SearchResult {
  excerpt: string;
  href: string;
  kind: "page" | "section";
  section: string;
  title: string;
}

interface SearchIndexSection extends SearchIndexEntry {
  contentParts: string[];
}

const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 20;
const EXCERPT_RADIUS = 72;
const WHITESPACE_RE = /\s+/;
const HEADING_2_RE = /^##\s+(.+)$/;
const HEADING_3_RE = /^###\s+(.+)$/;

const searchSchema = {
  title: "string",
  section: "string",
  description: "string",
  content: "string",
  href: "string",
  kind: "string",
  order: "number",
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

function createExcerpt(content: string, description: string, query: string): string {
  const source = content.length > 0 ? content : description;
  if (source.length === 0) {
    return "";
  }

  const normalizedSource = source.toLowerCase();
  const queryTerms = query
    .toLowerCase()
    .split(WHITESPACE_RE)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);

  const matchIndex = queryTerms.reduce((bestIndex, term) => {
    const index = normalizedSource.indexOf(term);
    if (index === -1) {
      return bestIndex;
    }

    if (bestIndex === -1 || index < bestIndex) {
      return index;
    }

    return bestIndex;
  }, -1);

  if (matchIndex === -1) {
    return source.length > 160 ? `${source.slice(0, 157).trimEnd()}...` : source;
  }

  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end = Math.min(source.length, matchIndex + query.length + EXCERPT_RADIUS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < source.length ? "..." : "";

  return `${prefix}${source.slice(start, end).trim()}${suffix}`;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) {
    return SEARCH_DEFAULT_LIMIT;
  }

  return Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(limit)));
}

export function buildSearchEntriesForDoc(doc: DocNavItem, markdown: string, orderOffset: number) {
  const normalizedMarkdown = normalizeMarkdown(markdown);
  const lines = normalizedMarkdown.split("\n");
  const headingIds = new Map<string, number>();
  const pageContentParts: string[] = [];
  const sections: SearchIndexSection[] = [];

  let nextOrder = orderOffset;
  let activeH2: SearchIndexSection | undefined;
  let activeH3: SearchIndexSection | undefined;

  function createSection(headingText: string): SearchIndexSection {
    const slug = getUniqueHeadingId(headingText, headingIds);
    const entry: SearchIndexSection = {
      content: "",
      contentParts: [],
      description: doc.description,
      href: `${doc.href}#${slug}`,
      id: `${doc.href}#${slug}`,
      kind: "section",
      order: nextOrder++,
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
    activeH2?.contentParts.push(text);
    activeH3?.contentParts.push(text);
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
    order: nextOrder++,
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
      title: 5,
      section: 3,
      description: 2,
      content: 1,
    },
    limit: limit * 2,
    properties: ["title", "section", "description", "content"],
    term: query,
  });

  const dedupedResults = new Map<string, SearchResult & { order: number; score: number }>();

  for (const hit of response.hits) {
    const document = hit.document as SearchIndexEntry;
    const existingResult = dedupedResults.get(document.href);

    const nextResult = {
      excerpt: createExcerpt(document.content, document.description, query),
      href: document.href,
      kind: document.kind,
      order: document.order,
      score: hit.score,
      section: document.section,
      title: document.title,
    };

    if (!existingResult || hit.score > existingResult.score) {
      dedupedResults.set(document.href, nextResult);
    }
  }

  return [...dedupedResults.values()]
    .sort((left, right) => {
      if (right.score === left.score) {
        return left.order - right.order;
      }

      return right.score - left.score;
    })
    .slice(0, limit)
    .map(({ order: _order, score: _score, ...result }) => result);
}
