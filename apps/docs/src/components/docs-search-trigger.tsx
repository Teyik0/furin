import { Search } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

const SearchDialog = lazy(() =>
  import("./docs-search-dialog").then((module) => ({ default: module.DocsSearchDialog }))
);

export function DocsSearch() {
  const [activated, setActivated] = useState(false);
  useEffect(() => {
    if (activated) {
      return;
    }
    const open = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setActivated(true);
      }
    };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, [activated]);
  const trigger = (
    <button
      className="flex h-8 w-full max-w-xs items-center gap-2 rounded-full border border-border bg-muted/40 px-3 text-muted-foreground transition-colors hover:border-border/80 hover:bg-muted/60"
      onClick={() => setActivated(true)}
      type="button"
    >
      <Search className="size-3.5 shrink-0" />
      <span className="flex-1 text-left text-xs">Search the docs…</span>
      <kbd className="hidden rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] leading-none sm:inline-flex">
        ⌘K / Ctrl K
      </kbd>
    </button>
  );
  return activated ? (
    <Suspense fallback={trigger}>
      <SearchDialog />
    </Suspense>
  ) : (
    trigger
  );
}
