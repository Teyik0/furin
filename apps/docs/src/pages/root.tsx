import "./globals.css";

import { createRoute } from "@teyik0/furin/client";
import { Link } from "@teyik0/furin/link";
import { DocsSearchDialog } from "@/components/docs-search-dialog";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 0C5.373 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.6.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23a11.5 11.5 0 0 1 3.003-.404c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.562 21.8 24 17.302 24 12 24 5.373 18.627 0 12 0z" />
    </svg>
  );
}

function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <header className="fixed top-0 z-50 w-full border-white/5 border-b bg-background/80 backdrop-blur-md">
        <nav className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
          {/* Left — logo */}
          <Link className="flex shrink-0 items-center gap-2" to="/">
            <img alt="Furin logo" height={26} src="/public/furin-logo.webp" width={26} />
            <span className="font-semibold text-sm">Furin</span>
          </Link>

          <div className="flex flex-1 justify-center">
            <DocsSearchDialog />
          </div>

          {/* Right — links + icons */}
          <div className="flex shrink-0 items-center gap-5">
            <div className="hidden items-center gap-5 sm:flex">
              <Link
                className="text-muted-foreground text-sm transition-colors hover:text-foreground"
                to="/docs"
              >
                Docs
              </Link>
            </div>
            <div className="flex items-center gap-0.5">
              <ThemeToggle />
              <a
                aria-label="GitHub"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                href="https://github.com/teyik0/furin"
                rel="noopener noreferrer"
                target="_blank"
              >
                <GithubIcon className="h-4 w-4" />
              </a>
            </div>
          </div>
        </nav>
      </header>

      <main className="pt-14">{children}</main>

      <footer className="border-border border-t bg-background">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <p className="text-muted-foreground text-sm">
              Built with Furin — React meta-framework on Bun + Elysia
            </p>
            <div className="flex gap-6">
              <a
                className="text-muted-foreground text-sm transition-colors hover:text-foreground"
                href="https://github.com/teyik0/furin"
                rel="noopener noreferrer"
                target="_blank"
              >
                GitHub
              </a>
              <a
                className="text-muted-foreground text-sm transition-colors hover:text-foreground"
                href="https://elysiajs.com"
                rel="noopener noreferrer"
                target="_blank"
              >
                Elysia
              </a>
              <a
                className="text-muted-foreground text-sm transition-colors hover:text-foreground"
                href="https://bun.com"
                rel="noopener noreferrer"
                target="_blank"
              >
                Bun
              </a>
            </div>
          </div>
        </div>
      </footer>
    </ThemeProvider>
  );
}

export const route = createRoute({
  layout: ({ children }) => <RootLayout>{children}</RootLayout>,
});
