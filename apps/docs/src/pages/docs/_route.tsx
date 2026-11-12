import { defineRoute } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { DocsMobileNav } from "@/components/docs-mobile-nav";
import { DocsPager } from "@/components/docs-pager";
import { DocsToc } from "@/components/docs-toc";
import { GiscusComments } from "@/components/giscus-comments";
import { DOCS_CARDS, getDocsNavigation } from "@/lib/docs";
import { getDocsPlatform } from "@/lib/docs-platform";

export const route = defineRoute("/docs/_route")
  .config({ mode: "ssg" })
  .layout(({ children, path }) => {
    // `path` is injected by Furin from componentProps (ctx.path server-side,
    // state.data.path client-side) — always correct on SSR and SPA navigation.
    const pathname = typeof path === "string" ? path : "/";
    const navigation = getDocsNavigation(pathname);
    const platform = getDocsPlatform(pathname);
    const current = DOCS_CARDS.find((doc) => doc.href === pathname);
    const currentSection = navigation.find((entry) =>
      entry.items.some((doc) => doc.href === pathname)
    );

    return (
      <div className="workbench-layout">
        <div className="workbench-mobile-nav lg:hidden">
          <DocsMobileNav pathname={pathname} />
        </div>

        <div className="workbench-grid">
          <aside className="workbench-sidebar hidden lg:block">
            <nav aria-label="Documentation" className="workbench-navigation">
              {navigation.map((section) => (
                <div key={section.title}>
                  <p className="mb-2 font-semibold text-foreground text-xs uppercase tracking-[0.24em]">
                    {section.title}
                  </p>
                  <ul className="space-y-1">
                    {section.items.map((item, itemIndex) => (
                      <li key={item.href}>
                        <Link
                          activeProps={({
                            isActive,
                          }: {
                            isActive: boolean;
                          }): React.AnchorHTMLAttributes<HTMLAnchorElement> =>
                            isActive
                              ? {
                                  className: "workbench-nav-link is-active",
                                }
                              : {}
                          }
                          className="workbench-nav-link"
                          to={item.href}
                        >
                          <span aria-hidden="true" className="workbench-nav-index">
                            {String(itemIndex + 1).padStart(2, "0")}
                          </span>
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
            <div className="workbench-sidebar-footer">
              Built on
              <br />
              <span>
                {platform === "desktop" ? "Furin · Electrobun · Bun" : "React · Elysia · Bun"}
              </span>
              <br />
              <br />
              風鈴 / Small by design.
            </div>
          </aside>

          <div className="workbench-editor">
            <div className="workbench-reading-grid">
              <div className="workbench-article">
                <div className="workbench-breadcrumb">
                  <Link to="/docs">Docs</Link>
                  {platform === "desktop" ? (
                    <>
                      <span aria-hidden="true">/</span>
                      <Link to="/docs/desktop">Desktop</Link>
                    </>
                  ) : null}
                  <span aria-hidden="true">/</span>
                  <span>{currentSection?.title}</span>
                  <span aria-hidden="true">/</span>
                  <span className="workbench-current">{current?.label}</span>
                </div>
                {children}
                <DocsPager pathname={pathname} />
                <GiscusComments key={pathname} />
              </div>
              <DocsToc key={pathname} />
            </div>
          </div>
        </div>
      </div>
    );
  });
