// biome-ignore-all lint/performance/noJsxPropsBind: docs route active link props are computed from router active state
import { defineRoute } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { DocsMobileNav } from "@/components/docs-mobile-nav";
import { DocsPager } from "@/components/docs-pager";
import { DocsToc } from "@/components/docs-toc";
import { GiscusComments } from "@/components/giscus-comments";
import { DOCS_NAV } from "@/lib/docs";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .layout(({ children, path }) => {
    // `path` is injected by Furin from componentProps (ctx.path server-side,
    // state.data.path client-side) — always correct on SSR and SPA navigation.
    const pathname = typeof path === "string" ? path : "/";

    return (
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 lg:hidden">
          <DocsMobileNav />
        </div>

        <div className="grid gap-10 lg:grid-cols-[15rem_minmax(0,1fr)] xl:grid-cols-[15rem_minmax(0,1fr)_15rem]">
          <aside className="sticky top-24 hidden max-h-[calc(100vh-6rem)] overflow-y-auto [scrollbar-width:none] lg:block [&::-webkit-scrollbar]:hidden">
            <nav className="space-y-6">
              {DOCS_NAV.map((section) => (
                <div key={section.title}>
                  <p className="mb-2 font-semibold text-foreground text-xs uppercase tracking-[0.24em]">
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
                                    "block rounded-lg px-3 py-2 text-sm transition-colors bg-accent text-foreground",
                                }
                              : {}
                          }
                          className="block rounded-lg px-3 py-2 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
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

          <div className="min-w-0">
            {children}
            <DocsPager pathname={pathname} />
            <GiscusComments key={pathname} />
          </div>

          <DocsToc key={pathname} />
        </div>
      </div>
    );
  });
