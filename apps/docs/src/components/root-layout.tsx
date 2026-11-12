import { Link, RouterContext } from "@teyik0/furin/link";
import { use } from "react";
import { CodeCopyBridge } from "@/components/code-copy-bridge";
import { DocsSearch } from "@/components/docs-search-trigger";
import { GithubIcon } from "@/components/icons";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { getDocsPlatform } from "@/lib/docs";

export function RootLayout({ children }: { children: React.ReactNode }) {
  // basePath is available during static pre-render (RouterContext injected) and on the client.
  // Falls back to "/public" in dev (Elysia static plugin serves public/ at /public/).
  const router = use(RouterContext);
  const imgPrefix = router?.basePath || "/public";
  const pathname = router?.currentHref.split("?")[0];
  const platform = getDocsPlatform(pathname ?? "/");
  const isDocs = pathname === "/docs" || pathname?.startsWith("/docs/") === true;

  return (
    <ThemeProvider>
      <CodeCopyBridge />
      <div className={isDocs ? "docs-workbench" : undefined}>
        <header className="fixed top-0 z-50 w-full border-white/5 border-b bg-background/80 backdrop-blur-md">
          <nav className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
            {/* Left — logo */}
            <Link className="flex shrink-0 items-center gap-2" to="/">
              <img alt="Furin logo" height={26} src={`${imgPrefix}/furin-logo.webp`} width={26} />
              <span className="font-semibold text-sm">{isDocs ? "furin" : "Furin"}</span>
            </Link>

            {isDocs ? (
              <nav aria-label="Documentation platform" className="docs-platform-switch">
                <Link aria-current={platform === "web" ? "true" : undefined} to="/docs">
                  Web
                </Link>
                <Link aria-current={platform === "desktop" ? "true" : undefined} to="/docs/desktop">
                  Desktop
                </Link>
              </nav>
            ) : null}
            <div className="docs-search-container flex flex-1 justify-center">
              <DocsSearch />
            </div>

            {/* Right — links + icons */}
            <div className="flex shrink-0 items-center gap-5">
              {isDocs ? null : (
                <div className="hidden items-center gap-5 sm:flex">
                  <Link
                    className="text-muted-foreground text-sm transition-colors hover:text-foreground"
                    to="/docs"
                  >
                    Docs
                  </Link>
                </div>
              )}
              <div className="flex items-center gap-0.5">
                <ThemeToggle />
                <a
                  aria-label="GitHub"
                  className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  href="https://github.com/teyik0/furin"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <GithubIcon className="size-4" />
                </a>
              </div>
            </div>
          </nav>
        </header>

        <main className="pt-14">{children}</main>
      </div>
    </ThemeProvider>
  );
}
