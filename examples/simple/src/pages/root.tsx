import { createRoute } from "@teyik0/furin/client";
import { Link } from "@teyik0/furin/link";
import "../styles/globals.css";

export const route = createRoute({
  layout: ({ children }) => (
    <div className="min-h-screen bg-[#080d18] text-white">
      <header className="fixed top-0 z-50 w-full border-white/5 border-b bg-[#080d18]/80 backdrop-blur-md">
        <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link className="flex items-center gap-2.5" to="/">
            <img alt="Furin logo" height={60} src="/public/furin-logo.webp" width={60} />
            <span className="font-bold text-lg text-white">Furin</span>
          </Link>

          <div className="hidden items-center gap-8 sm:flex">
            <a className="text-slate-400 text-sm transition-colors hover:text-white" href="/about">
              Documentation
            </a>
            <a className="text-slate-400 text-sm transition-colors hover:text-white" href="/blog">
              Examples
            </a>
            <a className="text-slate-400 text-sm transition-colors hover:text-white" href="/blog">
              Guides
            </a>
            <a
              className="text-slate-400 text-sm transition-colors hover:text-white"
              href="https://github.com/teyik0/furin"
              rel="noopener noreferrer"
              target="_blank"
            >
              GitHub
            </a>
          </div>

          <a
            className="rounded-full bg-blue-600 px-5 py-2 font-medium text-sm text-white transition-all hover:bg-blue-500 hover:shadow-blue-500/25 hover:shadow-lg"
            href="/dashboard"
          >
            Get Started
          </a>
        </nav>
      </header>

      <main className="pt-16">{children}</main>

      <footer className="border-white/5 border-t bg-[#080d18]">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <p className="text-slate-500 text-sm">
              Built with Furin — React meta-framework on Bun + Elysia
            </p>
            <div className="flex gap-6">
              <a
                className="text-slate-500 text-sm transition-colors hover:text-slate-300"
                href="https://github.com/teyik0/furin"
                rel="noopener noreferrer"
                target="_blank"
              >
                GitHub
              </a>
              <a
                className="text-slate-500 text-sm transition-colors hover:text-slate-300"
                href="https://elysiajs.com"
                rel="noopener noreferrer"
                target="_blank"
              >
                Elysia
              </a>
              <a
                className="text-slate-500 text-sm transition-colors hover:text-slate-300"
                href="https://bun.sh"
                rel="noopener noreferrer"
                target="_blank"
              >
                Bun
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  ),
});
