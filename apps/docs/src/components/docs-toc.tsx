import { useEffect, useReducer } from "react";
import { getUniqueHeadingId } from "@/lib/docs-heading";
import { cn } from "@/lib/utils";

interface HeadingItem {
  id: string;
  level: 2 | 3;
  text: string;
}

interface TocState {
  activeId: string;
  headings: HeadingItem[];
}

type TocAction = { headings: HeadingItem[]; type: "register" } | { id: string; type: "setActive" };

function tocReducer(state: TocState, action: TocAction): TocState {
  switch (action.type) {
    case "register":
      return { activeId: action.headings[0]?.id ?? "", headings: action.headings };
    case "setActive":
      return state.activeId === action.id ? state : { ...state, activeId: action.id };
    default:
      return state;
  }
}

export function DocsToc() {
  const [{ headings, activeId }, dispatch] = useReducer(tocReducer, {
    activeId: "",
    headings: [],
  });

  useEffect(() => {
    let observer: IntersectionObserver | null = null;
    let cancelled = false;
    let scrollRafId: number | null = null;
    let retryFrameId: number | null = null;

    function scrollToHashTarget(): void {
      if (cancelled) {
        return;
      }

      const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
      let hash: string;
      try {
        hash = decodeURIComponent(raw);
      } catch {
        hash = raw;
      }
      if (hash.length === 0) {
        return;
      }

      const target = document.getElementById(hash);
      if (!target) {
        return;
      }

      target.scrollIntoView({ behavior: "smooth", block: "start" });
      dispatch({ id: hash, type: "setActive" });
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: DOM traversal, IntersectionObserver setup, retry logic, and hash-scroll handling are inherently coupled; splitting further would obscure the intent
    function registerHeadings() {
      const article = document.getElementById("doc-content");
      if (!article) {
        return false;
      }

      const seen = new Map<string, number>();
      const elements = Array.from(article.querySelectorAll<HTMLHeadingElement>("h2, h3"));
      const nextHeadings: HeadingItem[] = [];
      // Only headings that get an id end up here — empty headings are skipped
      // entirely. The observer must watch THIS list, not `elements`: an
      // observed-but-id-less heading becoming the first visible entry would
      // make the callback's `target.id` guard fall through and freeze the
      // active TOC item.
      const observedHeadings: HTMLHeadingElement[] = [];
      for (const element of elements) {
        const text = element.textContent ?? "";
        if (text.length === 0) {
          continue;
        }
        const id = getUniqueHeadingId(text, seen);
        element.id = id;
        observedHeadings.push(element);
        nextHeadings.push({
          id,
          level: element.tagName === "H2" ? 2 : 3,
          text,
        } satisfies HeadingItem);
      }

      dispatch({ headings: nextHeadings, type: "register" });
      scrollRafId = window.requestAnimationFrame(() => {
        scrollRafId = null;
        scrollToHashTarget();
      });

      if (nextHeadings.length === 0) {
        return true;
      }

      observer = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((entry) => entry.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

          if (visible[0]?.target.id) {
            dispatch({ id: visible[0].target.id, type: "setActive" });
          }
        },
        {
          rootMargin: "-96px 0px -65% 0px",
          threshold: [0, 1],
        }
      );

      for (const element of observedHeadings) {
        observer.observe(element);
      }

      return true;
    }

    window.addEventListener("hashchange", scrollToHashTarget);

    if (!registerHeadings()) {
      // Retry up to 5 animation frames — handles slow MDX renders without
      // blocking layout or triggering excessive work.
      let attempts = 0;
      const MAX_ATTEMPTS = 5;
      const retry = () => {
        if (cancelled || attempts >= MAX_ATTEMPTS) {
          return;
        }
        attempts++;
        if (!registerHeadings()) {
          retryFrameId = window.requestAnimationFrame(retry);
        }
      };

      retryFrameId = window.requestAnimationFrame(retry);
    }

    return () => {
      cancelled = true;
      if (scrollRafId !== null) {
        window.cancelAnimationFrame(scrollRafId);
      }
      if (retryFrameId !== null) {
        window.cancelAnimationFrame(retryFrameId);
      }
      window.removeEventListener("hashchange", scrollToHashTarget);
      if (observer !== null) {
        observer.disconnect();
      }
    };
  }, []);

  if (headings.length === 0) {
    return null;
  }

  return (
    <aside className="hidden w-56 shrink-0 xl:block">
      <div className="sticky top-24">
        <p className="mb-4 font-semibold text-foreground text-sm">On this page</p>
        <nav>
          <ul className="space-y-1 border-border border-l pl-4">
            {headings.map((heading) => (
              <li key={heading.id}>
                {/* react-doctor-disable-next-line react-doctor/no-prevent-default */}
                <a
                  className={cn(
                    "block w-full py-1 text-left text-sm transition-colors",
                    heading.level === 3 && "pl-4 text-xs",
                    activeId === heading.id
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  href={`#${heading.id}`}
                  onClick={(event) => {
                    // Let the browser handle modifier/non-primary clicks
                    // (new tab, copy link). Only upgrade plain primary-click
                    // to smooth-scroll behavior.
                    if (
                      event.button !== 0 ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    ) {
                      return;
                    }
                    const target = document.getElementById(heading.id);
                    if (!target) {
                      return;
                    }
                    event.preventDefault();
                    target.scrollIntoView({ behavior: "smooth", block: "start" });
                    window.history.replaceState(null, "", `#${heading.id}`);
                    dispatch({ id: heading.id, type: "setActive" });
                  }}
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </aside>
  );
}
