"use client";

import { useEffect, useState } from "react";
import { getUniqueHeadingId } from "@/lib/docs-heading";
import { cn } from "@/lib/utils";

interface HeadingItem {
  id: string;
  level: 2 | 3;
  text: string;
}

export function DocsToc() {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    let observer: IntersectionObserver | null = null;
    let cancelled = false;

    function scrollToHashTarget(): void {
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
      setActiveId(hash);
    }

    function registerHeadings() {
      const article = document.getElementById("doc-content");
      if (!article) {
        return false;
      }

      const seen = new Map<string, number>();
      const elements = Array.from(article.querySelectorAll<HTMLHeadingElement>("h2, h3"));
      const nextHeadings = elements
        .map((element) => {
          const id = getUniqueHeadingId(element.textContent ?? "", seen);
          element.id = id;

          return {
            id,
            level: element.tagName === "H2" ? 2 : 3,
            text: element.textContent ?? "",
          } satisfies HeadingItem;
        })
        .filter((heading) => heading.text.length > 0);

      setHeadings(nextHeadings);
      setActiveId(nextHeadings[0]?.id ?? "");
      window.requestAnimationFrame(() => {
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
            setActiveId(visible[0].target.id);
          }
        },
        {
          rootMargin: "-96px 0px -65% 0px",
          threshold: [0, 1],
        }
      );

      for (const element of elements) {
        observer.observe(element);
      }

      return true;
    }

    window.addEventListener("hashchange", scrollToHashTarget);

    if (!registerHeadings()) {
      const frame = window.requestAnimationFrame(() => {
        if (!cancelled) {
          registerHeadings();
        }
      });

      return () => {
        cancelled = true;
        window.cancelAnimationFrame(frame);
        window.removeEventListener("hashchange", scrollToHashTarget);
        observer?.disconnect();
      };
    }

    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", scrollToHashTarget);
      observer?.disconnect();
    };
  }, []);

  if (headings.length === 0) {
    return null;
  }

  return (
    <aside className="hidden xl:block">
      <div className="sticky top-24">
        <p className="mb-4 font-semibold text-foreground text-sm">On this page</p>
        <nav>
          <ul className="space-y-1 border-border border-l pl-4">
            {headings.map((heading) => (
              <li key={heading.id}>
                <a
                  className={cn(
                    "block py-1 text-sm transition-colors",
                    heading.level === 3 && "pl-4 text-xs",
                    activeId === heading.id
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  href={`#${heading.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    const target = document.getElementById(heading.id);
                    if (!target) {
                      return;
                    }

                    target.scrollIntoView({ behavior: "smooth", block: "start" });
                    window.history.replaceState(null, "", `#${heading.id}`);
                    setActiveId(heading.id);
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
