import type { AnyOrama } from "@orama/orama";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRouter } from "@teyik0/furin/link";
import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SearchIndexEntry } from "@/lib/docs-search";
import { SEARCH_MIN_QUERY_LENGTH, type SearchResult } from "@/lib/docs-search-shared";
import { cn } from "@/lib/utils";
import { DocsQueryProvider } from "./docs-query-provider";

const SEARCH_DEBOUNCE_MS = 180;
const MAC_PLATFORM_RE = /Mac|iPhone|iPad|iPod/;

function getShortcutLabel(): string {
  if (typeof navigator === "undefined") {
    return "⌘K";
  }
  return MAC_PLATFORM_RE.test(navigator.platform) ? "⌘K" : "Ctrl K";
}

// Loads the search index served at `${basePath}/search-entries.json` (the
// /search-entries.json Elysia route in dev, a static file in deployments) and
// rebuilds the Orama index. Throwing here surfaces as `indexQuery.isError`.
async function loadSearchIndex(basePath: string): Promise<AnyOrama> {
  const response = await fetch(`${basePath}/search-entries.json`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const entries = await response.json();
  if (!Array.isArray(entries)) {
    throw new Error("Search index payload is not an array");
  }
  const { createDocsSearchIndex } = await import("@/lib/docs-search-client");
  return createDocsSearchIndex(entries as SearchIndexEntry[]);
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [value, delayMs]);

  return debounced;
}

function StatusMessage({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-10 text-center text-muted-foreground text-sm">{children}</div>;
}

function SearchResultItem({
  result,
  isActive,
  onSelect,
  onHover,
}: {
  isActive: boolean;
  onHover: () => void;
  onSelect: () => void;
  result: SearchResult;
}) {
  return (
    <li>
      {/* react-doctor-disable-next-line react-doctor/no-prevent-default */}
      <a
        className={cn(
          "block rounded-xl px-3 py-3 transition-colors",
          isActive ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"
        )}
        href={result.href}
        onClick={(event) => {
          // Let the browser handle modifier-clicks (new tab, new window, download)
          // and non-primary buttons. Only intercept plain primary-click for SPA nav.
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          onSelect();
        }}
        onMouseEnter={onHover}
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
          <p className="mt-2 line-clamp-2 text-muted-foreground text-sm">{result.excerpt}</p>
        ) : null}
      </a>
    </li>
  );
}

function SearchResultsArea({
  results,
  activeIndex,
  isQueryLongEnough,
  indexFailed,
  isSearching,
  onSelect,
  onHover,
}: {
  activeIndex: number;
  indexFailed: boolean;
  isQueryLongEnough: boolean;
  isSearching: boolean;
  onHover: (index: number) => void;
  onSelect: (href: string) => void;
  results: SearchResult[];
}) {
  if (!isQueryLongEnough) {
    return <StatusMessage>Search the docs…</StatusMessage>;
  }
  if (indexFailed) {
    return <StatusMessage>Search is temporarily unavailable.</StatusMessage>;
  }
  if (results.length > 0) {
    return (
      <ul className="p-2">
        {results.map((result, index) => (
          <SearchResultItem
            isActive={activeIndex === index}
            key={result.href}
            onHover={() => onHover(index)}
            onSelect={() => onSelect(result.href)}
            result={result}
          />
        ))}
      </ul>
    );
  }
  if (isSearching) {
    return <StatusMessage>Searching documentation…</StatusMessage>;
  }
  return <StatusMessage>No results found.</StatusMessage>;
}

export function DocsSearchDialog() {
  return (
    <DocsQueryProvider>
      <SearchDialog />
    </DocsQueryProvider>
  );
}

function SearchDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);

  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const trimmedQuery = query.trim();
  const trimmedDebounced = debouncedQuery.trim();
  const isQueryLongEnough = trimmedQuery.length >= SEARCH_MIN_QUERY_LENGTH;

  // Index load: kicks off when the dialog first opens, then cached for the
  // session (staleTime: Infinity from the QueryClient defaults).
  const {
    data: searchIndex,
    isSuccess: isIndexReady,
    isError: isIndexError,
    isLoading: isIndexLoading,
  } = useQuery({
    enabled: open,
    queryFn: () => loadSearchIndex(router.basePath),
    queryKey: ["docs-search-index", router.basePath],
  });

  // Search: re-keyed on the debounced query, so React Query owns staleness —
  // an out-of-order resolution can never overwrite a newer query's results.
  const { data: searchData, isFetching: isSearchFetching } = useQuery({
    enabled: isIndexReady && trimmedDebounced.length >= SEARCH_MIN_QUERY_LENGTH,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { runDocsSearch } = await import("@/lib/docs-search-client");
      return runDocsSearch(searchIndex as AnyOrama, trimmedDebounced);
    },
    queryKey: ["docs-search", trimmedDebounced],
  });

  const results = isQueryLongEnough ? (searchData ?? []) : [];
  const isSearching =
    isQueryLongEnough &&
    results.length === 0 &&
    !isIndexError &&
    (isIndexLoading || isSearchFetching || trimmedQuery !== trimmedDebounced);

  const navigateToResult = useCallback(
    (href: string): void => {
      const url = new URL(href, window.location.origin);
      const hash = url.hash.startsWith("#") ? decodeURIComponent(url.hash.slice(1)) : "";

      // Same-page anchor: smooth scroll without triggering a full page fetch.
      if (url.pathname === window.location.pathname && hash.length > 0) {
        const target = document.getElementById(hash);
        if (!target) {
          return;
        }
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        window.history.replaceState(null, "", `${url.pathname}${url.hash}`);
        return;
      }

      // Cross-page: SPA navigation via RouterProvider (no full reload).
      router.navigate(`${url.pathname}${url.search}${url.hash}`);
    },
    [router]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) {
          closeButtonRef.current?.click();
          return;
        }
        triggerButtonRef.current?.click();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const selectResult = (href: string): void => {
    closeButtonRef.current?.click();
    navigateToResult(href);
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) =>
        results.length === 0 ? 0 : Math.min(current + 1, results.length - 1)
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (results.length === 0 ? 0 : Math.max(current - 1, 0)));
      return;
    }
    if (event.key === "Enter") {
      const activeResult = results[activeIndex];
      if (!activeResult) {
        return;
      }
      event.preventDefault();
      selectResult(activeResult.href);
    }
  };

  const shortcutLabel = getShortcutLabel();

  return (
    <DialogRoot defaultOpen>
      <DialogTrigger asChild>
        <button
          className="flex h-8 w-full max-w-xs items-center gap-2 rounded-full border border-border bg-muted/40 px-3 text-muted-foreground transition-colors hover:border-border/80 hover:bg-muted/60"
          onClick={() => {
            setOpen(true);
          }}
          ref={triggerButtonRef}
          type="button"
        >
          <Search className="size-3.5 shrink-0" />
          <span className="flex-1 text-left text-xs">Search the docs…</span>
          <kbd className="hidden rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] leading-none sm:inline-flex">
            {shortcutLabel}
          </kbd>
        </button>
      </DialogTrigger>

      <DialogContent
        className="gap-0 p-0"
        onCloseAutoFocus={() => {
          setOpen(false);
          setQuery("");
          setActiveIndex(0);
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogClose asChild>
          <button className="sr-only" ref={closeButtonRef} tabIndex={-1} type="button">
            Close search
          </button>
        </DialogClose>
        <div className="border-border border-b p-4">
          <DialogTitle className="sr-only">Search the docs</DialogTitle>
          <DialogDescription className="sr-only">
            Search Furin documentation pages and jump directly to matching sections.
          </DialogDescription>
          <div className="flex items-center gap-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              className="h-11 border-0 px-0 shadow-none focus-visible:border-0 focus-visible:ring-0"
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleInputKeyDown}
              placeholder="Search the docs…"
              ref={inputRef}
              value={query}
            />
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          <SearchResultsArea
            activeIndex={activeIndex}
            indexFailed={isIndexError}
            isQueryLongEnough={isQueryLongEnough}
            isSearching={isSearching}
            onHover={setActiveIndex}
            onSelect={selectResult}
            results={results}
          />
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
