"use client";

import { type AnyOrama, create, insertMultiple, search as oramaSearch } from "@orama/orama";
import { useRouter } from "@teyik0/furin/link";
import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SearchIndexEntry } from "@/lib/docs-search";
import { cn } from "@/lib/utils";

type OramaIndex = AnyOrama;

const ORAMA_SCHEMA = {
  title: "string",
  section: "string",
  description: "string",
  content: "string",
  href: "string",
  kind: "string",
  order: "number",
} satisfies Record<string, "string" | "number" | "boolean">;

const EXCERPT_RADIUS = 72;
const WHITESPACE_RE = /\s+/;

function createExcerpt(content: string, description: string, query: string): string {
  const source = content.length > 0 ? content : description;
  if (source.length === 0) {
    return "";
  }

  const normalizedSource = source.toLowerCase();
  const queryTerms = query
    .toLowerCase()
    .split(WHITESPACE_RE)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const matchIndex = queryTerms.reduce((best, term) => {
    const idx = normalizedSource.indexOf(term);
    if (idx === -1) {
      return best;
    }
    return best === -1 || idx < best ? idx : best;
  }, -1);

  if (matchIndex === -1) {
    return source.length > 160 ? `${source.slice(0, 157).trimEnd()}...` : source;
  }

  const start = Math.max(0, matchIndex - EXCERPT_RADIUS);
  const end = Math.min(source.length, matchIndex + query.length + EXCERPT_RADIUS);
  return `${start > 0 ? "..." : ""}${source.slice(start, end).trim()}${end < source.length ? "..." : ""}`;
}

interface SearchResult {
  excerpt: string;
  href: string;
  kind: "page" | "section";
  section: string;
  title: string;
}

const MAC_PLATFORM_RE = /Mac|iPhone|iPad|iPod/;

function isMacLikePlatform(value: string): boolean {
  return MAC_PLATFORM_RE.test(value);
}

function getShortcutLabel(): string {
  if (typeof navigator === "undefined") {
    return "⌘K";
  }

  return isMacLikePlatform(navigator.platform) ? "⌘K" : "Ctrl K";
}

export function DocsSearchDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [indexReady, setIndexReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const oramaIndexRef = useRef<OramaIndex | null>(null);
  const indexLoadingRef = useRef(false);

  const navigateToResult = useCallback(
    (href: string): void => {
      const url = new URL(href, window.location.origin);
      const hash = url.hash.startsWith("#") ? decodeURIComponent(url.hash.slice(1)) : "";

      // Same-page anchor: smooth scroll without triggering a full page fetch
      if (url.pathname === window.location.pathname && hash.length > 0) {
        const target = document.getElementById(hash);
        if (!target) {
          return;
        }
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        window.history.replaceState(null, "", `${url.pathname}${url.hash}`);
        return;
      }

      // Cross-page: SPA navigation via RouterProvider (no full reload)
      router.navigate(`${url.pathname}${url.search}${url.hash}`);
    },
    [router]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((currentOpen) => !currentOpen);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    const timeout = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [open]);

  // Load the search index JSON once when the dialog first opens.
  // The file is served at `${basePath}/search-entries.json` in both dev
  // (via the /search-entries.json Elysia route) and static deployments
  // (copied from public/ to dist/ at build time).
  useEffect(() => {
    if (!open || oramaIndexRef.current || indexLoadingRef.current) {
      return;
    }

    indexLoadingRef.current = true;
    const url = `${router.basePath}/search-entries.json`;

    fetch(url)
      .then((r) => r.json())
      .then(async (entries: SearchIndexEntry[]) => {
        const index = create({ schema: ORAMA_SCHEMA });
        await insertMultiple(index, entries);
        oramaIndexRef.current = index;
        setIndexReady(true);
      })
      .catch((err) => {
        console.error("[search] Failed to load search index:", err);
        indexLoadingRef.current = false;
      });
  }, [open, router.basePath]);

  // Run a local Orama search whenever the query or index changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: oramaIndexRef is a ref — intentionally excluded
  useEffect(() => {
    if (!open) {
      return;
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 2) {
      setResults([]);
      setLoading(false);
      setActiveIndex(0);
      return;
    }

    const index = oramaIndexRef.current;
    if (!index) {
      // Index still loading — show spinner and wait for indexReady to re-fire
      setLoading(true);
      return;
    }

    setLoading(true);
    const timeout = window.setTimeout(async () => {
      try {
        const response = await oramaSearch(index, {
          boost: { title: 5, section: 3, description: 2, content: 1 },
          limit: 16,
          properties: ["title", "section", "description", "content"],
          term: trimmedQuery,
        });

        // Deduplicate by href, keep highest-score hit per page/section
        const deduped = new Map<string, SearchResult & { order: number; score: number }>();
        for (const hit of response.hits) {
          const doc = hit.document;
          const existing = deduped.get(doc.href);
          const next = {
            excerpt: createExcerpt(doc.content, doc.description, trimmedQuery),
            href: doc.href,
            kind: doc.kind,
            order: doc.order,
            score: hit.score,
            section: doc.section,
            title: doc.title,
          };
          if (!existing || hit.score > existing.score) {
            deduped.set(doc.href, next);
          }
        }

        const sorted = [...deduped.values()]
          .sort((a, b) => (b.score === a.score ? a.order - b.order : b.score - a.score))
          .slice(0, 8)
          .map(({ order: _o, score: _s, ...result }) => result);

        setResults(sorted);
        setActiveIndex(0);
      } catch (err) {
        console.error("[search] Search failed:", err);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 180);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [open, query, indexReady]);

  const shortcutLabel = getShortcutLabel();

  return (
    <DialogRoot
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setQuery("");
          setResults([]);
          setLoading(false);
          setActiveIndex(0);
        }
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <button
          className="flex h-8 w-full max-w-xs items-center gap-2 rounded-full border border-border bg-muted/40 px-3 text-muted-foreground transition-colors hover:border-border/80 hover:bg-muted/60"
          type="button"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 text-left text-xs">Search the docs...</span>
          <kbd className="hidden rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] leading-none sm:inline-flex">
            {shortcutLabel}
          </kbd>
        </button>
      </DialogTrigger>

      <DialogContent className="gap-0 p-0">
        <div className="border-border border-b p-4">
          <DialogTitle className="sr-only">Search the docs</DialogTitle>
          <DialogDescription className="sr-only">
            Search Furin documentation pages and jump directly to matching sections.
          </DialogDescription>
          <div className="flex items-center gap-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              className="h-11 border-0 px-0 shadow-none focus-visible:border-0 focus-visible:ring-0"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((currentIndex) =>
                    results.length === 0 ? 0 : Math.min(currentIndex + 1, results.length - 1)
                  );
                  return;
                }

                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((currentIndex) =>
                    results.length === 0 ? 0 : Math.max(currentIndex - 1, 0)
                  );
                  return;
                }

                if (event.key === "Enter") {
                  const activeResult = results[activeIndex];
                  if (!activeResult) {
                    return;
                  }

                  event.preventDefault();
                  setOpen(false);
                  navigateToResult(activeResult.href);
                }
              }}
              placeholder="Search the docs..."
              ref={inputRef}
              value={query}
            />
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {query.trim().length < 2 ? (
            <div className="px-4 py-10 text-center text-muted-foreground text-sm">
              Search the docs...
            </div>
          ) : null}

          {query.trim().length >= 2 && loading ? (
            <div className="px-4 py-10 text-center text-muted-foreground text-sm">
              Searching documentation...
            </div>
          ) : null}

          {query.trim().length >= 2 && !loading && results.length === 0 ? (
            <div className="px-4 py-10 text-center text-muted-foreground text-sm">
              No results found.
            </div>
          ) : null}

          {results.length > 0 ? (
            <ul className="p-2">
              {results.map((result, index) => (
                <li key={result.href}>
                  <a
                    className={cn(
                      "block rounded-xl px-3 py-3 transition-colors",
                      activeIndex === index
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted/60"
                    )}
                    href={result.href}
                    onClick={(event) => {
                      event.preventDefault();
                      setOpen(false);
                      navigateToResult(result.href);
                    }}
                    onMouseEnter={() => {
                      setActiveIndex(index);
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-sm">{result.title}</p>
                        {result.section.length > 0 ? (
                          <p className="mt-1 text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
                            {result.section}
                          </p>
                        ) : null}
                      </div>
                      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground uppercase tracking-[0.16em]">
                        {result.kind}
                      </span>
                    </div>
                    {result.excerpt.length > 0 ? (
                      <p className="mt-2 line-clamp-2 text-muted-foreground text-sm">
                        {result.excerpt}
                      </p>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
