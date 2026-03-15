import { createRoute } from "furinjs/client";
import { Link } from "furinjs/link";
import "../styles/globals.css";

// Root layout renders body content only — <html>, <head>, <body> are provided
// by .furin/index.html (the SSR template processed by Bun's HTML bundler).
export const route = createRoute({
  layout: ({ children }) => (
    <div className="flex min-h-screen flex-col bg-gray-50 text-gray-900">
      <header className="border-gray-200 border-b bg-white">
        <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 justify-between">
            <div className="flex">
              <Link className="flex items-center gap-2 font-bold text-indigo-600 text-xl" to="/">
                <img
                  alt="Furin logo"
                  className="rounded-full"
                  height={30}
                  src="/public/furin-logo.png"
                  width={30}
                />
                Furin
              </Link>
              <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                <Link
                  className="inline-flex items-center px-1 pt-1 font-medium text-gray-900 text-sm transition-colors hover:text-indigo-600"
                  to="/"
                >
                  Home
                </Link>
                <Link
                  className="inline-flex items-center px-1 pt-1 font-medium text-gray-500 text-sm transition-colors hover:text-indigo-600"
                  preload="viewport"
                  to="/blog"
                >
                  Blog
                </Link>
                <Link
                  className="inline-flex items-center px-1 pt-1 font-medium text-gray-500 text-sm transition-colors hover:text-indigo-600"
                  preload="viewport"
                  to="/about"
                >
                  About
                </Link>
                <Link
                  className="inline-flex items-center px-1 pt-1 font-medium text-gray-500 text-sm transition-colors hover:text-indigo-600"
                  preload="viewport"
                  to="/dashboard"
                >
                  Dashboard
                </Link>
              </div>
            </div>
            <div className="flex items-center">
              <Link
                className="ml-4 rounded-md bg-indigo-600 px-4 py-2 font-medium text-sm text-white transition-colors hover:bg-indigo-700"
                to="/login"
              >
                Sign In
              </Link>
            </div>
          </div>
        </nav>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="mt-auto border-gray-200 border-t bg-white">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <p className="text-gray-500 text-sm">Built with Furin - React meta-framework on Bun</p>
            <div className="flex space-x-6">
              <a
                className="text-gray-400 text-sm hover:text-gray-500"
                href="https://github.com/teyik0/furin"
              >
                GitHub
              </a>
              <a className="text-gray-400 text-sm hover:text-gray-500" href="https://elysiajs.com">
                Elysia
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  ),
});
