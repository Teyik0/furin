import { describe, expect, test } from "bun:test";
import { DOCS_CARDS } from "../src/lib/docs";
import {
  buildSearchEntriesForDoc,
  getSearchIndexEntries,
  searchDocs,
} from "../src/lib/docs-search";
import { createDocsServer } from "../src/server";

describe("docs search index", () => {
  test("indexes every docs page declared in the docs nav", () => {
    const entries = getSearchIndexEntries();
    const pageEntries = entries.filter((entry) => entry.kind === "page");

    expect(pageEntries).toHaveLength(DOCS_CARDS.length);
    expect(pageEntries.map((entry) => entry.href).sort()).toEqual(
      DOCS_CARDS.map((doc) => doc.href).sort()
    );
  });

  test("extracts h2 and h3 sections with TOC-compatible anchors", () => {
    const doc = DOCS_CARDS[0];
    const { entries } = buildSearchEntriesForDoc(
      doc,
      `
# Documentation

## Getting Started
Start here.

### First Page
Ship the first page.
      `,
      0
    );

    expect(entries.some((entry) => entry.href === "/docs#getting-started")).toBe(true);
    expect(entries.some((entry) => entry.href === "/docs#first-page")).toBe(true);
  });

  test("ignores fenced code blocks in indexed content", () => {
    const doc = DOCS_CARDS[0];
    const { entries } = buildSearchEntriesForDoc(
      doc,
      `
# Documentation

Visible text.

\`\`\`ts
const hiddenOnlyInCode = true;
\`\`\`
      `,
      0
    );

    expect(entries[0].content).toContain("Visible text.");
    expect(entries[0].content).not.toContain("hiddenOnlyInCode");
  });

  test("returns no result for too-short queries", async () => {
    expect(await searchDocs("a", 8)).toEqual([]);
  });

  test("finds a page by title", async () => {
    const results = await searchDocs("routing", 8);

    expect(results.some((result) => result.href === "/docs/routing")).toBe(true);
  });

  test("finds a section by heading or paragraph content", async () => {
    const results = await searchDocs("typed links", 8);

    expect(results.some((result) => result.href.includes("/docs/routing#"))).toBe(true);
  });

  test("deduplicates exact href matches", async () => {
    const results = await searchDocs("deployment", 8);
    const hrefs = results.map((result) => result.href);

    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("docs search endpoint", () => {
  test("returns docs search results from the API", async () => {
    const app = await createDocsServer();
    const response = await app.handle(new Request("http://localhost/api/search?q=routing"));
    const body = (await response.json()) as { results: Array<{ href: string }> };

    expect(response.status).toBe(200);
    expect(body.results.some((result) => result.href === "/docs/routing")).toBe(true);
  });

  test("returns data-loading matches for loader queries", async () => {
    const app = await createDocsServer();
    const response = await app.handle(new Request("http://localhost/api/search?q=loader"));
    const body = (await response.json()) as { results: Array<{ href: string }> };

    expect(body.results.some((result) => result.href.startsWith("/docs/data-loading"))).toBe(true);
  });
});
