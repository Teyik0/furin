import { defineRoute } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { DocsMobileNav } from "@/components/docs-mobile-nav";
import { DocsPager } from "@/components/docs-pager";
import { DocsToc } from "@/components/docs-toc";
import { GiscusComments } from "@/components/giscus-comments";
import { DOCS_NAV } from "@/lib/docs";

export const route = defineRoute("/docs/_route")
  .config({ mode: "ssg" })
  .layout(({ children, path }) => {
    // `path` is injected by Furin from componentProps (ctx.path server-side,
    // state.data.path client-side) — always correct on SSR and SPA navigation.
    const pathname = typeof path === "string" ? path : "/";

    return (
      <div className="flex w-full">
        {/* Fumadocs-style shell: the nav is docked to the left edge of the
            viewport, full height under the fixed header, with its own column
            and border. */}
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] shrink-0 self-start overflow-y-auto px-6 pt-8 pb-10 [scrollbar-width:none] lg:block lg:w-[248px] [&::-webkit-scrollbar]:hidden">
          <nav className="space-y-6">
            {DOCS_NAV.map((section) => (
              <div key={section.title}>
                <p className="mb-2 font-medium text-[11px] text-foreground uppercase tracking-[0.2em]">
                  {section.title}
                </p>
                <ul className="space-y-1">
                  {section.items.map((item) => (
                    <li key={item.href}>
                      <Link
                        activeProps={({
                          isActive,
                        }: {
                          isActive: boolean;
                        }): React.AnchorHTMLAttributes<HTMLAnchorElement> =>
                          isActive
                            ? {
                                className:
                                  "block rounded-lg px-3 py-1.5 text-[13px] transition-colors bg-accent text-foreground",
                              }
                            : {}
                        }
                        className="block rounded-lg px-3 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        to={item.href}
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
          <div className="px-4 pt-8 sm:px-6 lg:hidden">
            <DocsMobileNav />
          </div>

          <div className="flex items-start justify-center gap-10 px-4 py-8 pb-16 sm:px-6">
            <div className="w-full min-w-0 max-w-[calc(48rem-4rem)]">
              {children}
              <DocsPager pathname={pathname} />
              <GiscusComments key={pathname} />
            </div>

            <DocsToc key={pathname} />
          </div>
        </div>
      </div>
    );
  });
