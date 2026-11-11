import { Link } from "@teyik0/furin/link";
import { DOCS_NAV } from "@/lib/docs";

/**
 * Docs home overview: one card per navigation section, mirroring the sidebar
 * hierarchy so the /docs landing page summarizes the whole area at a glance.
 */
export function DocsSectionCards() {
  return (
    <div className="not-prose mt-10 grid gap-4 sm:grid-cols-2">
      {DOCS_NAV.map((section) => (
        <div
          className="flex flex-col rounded-xl border bg-card/60 p-5 transition-colors hover:border-foreground/20"
          key={section.title}
        >
          <p className="mb-3 font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
            {section.title}
          </p>
          <ul className="space-y-2.5">
            {section.items.map((item) => (
              <li key={item.href}>
                <Link
                  className="group flex flex-col gap-0.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted"
                  to={item.href}
                >
                  <span className="font-medium text-[13.5px] text-foreground group-hover:underline">
                    {item.label}
                  </span>
                  <span className="text-[13px] text-muted-foreground leading-snug">
                    {item.description}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
