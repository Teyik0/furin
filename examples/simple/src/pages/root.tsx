import { createRoute } from "@teyik0/furin/client";
import { Link } from "@teyik0/furin/link";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { authClient } from "@/lib/auth-client";
import "../styles/globals.css";

function NavbarAuth() {
  const { data: session } = authClient.useSession();

  if (session?.user) {
    return (
      <div className="flex items-center gap-3">
        <img
          alt={session.user.name ?? "User"}
          className="h-8 w-8 rounded-full"
          height={32}
          src={session.user.image ?? undefined}
          width={32}
        />
        <button
          className="text-muted-foreground text-sm transition-colors hover:text-foreground"
          onClick={() => authClient.signOut()}
          type="button"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <a
      className="rounded-full bg-blue-600 px-5 py-2 font-medium text-sm text-white transition-all hover:bg-blue-500 hover:shadow-blue-500/25 hover:shadow-lg"
      href="/login"
    >
      Sign in
    </a>
  );
}

function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <header className="fixed top-0 z-50 w-full border-white/5 border-b bg-background/80 backdrop-blur-md">
        <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link className="flex items-center gap-2.5" to="/">
            <img alt="Furin logo" height={60} src="/public/furin-logo.webp" width={60} />
            <span className="font-bold text-lg">Furin</span>
          </Link>

          <div className="hidden items-center gap-8 sm:flex">
            <Link
              className="text-muted-foreground text-sm transition-colors hover:text-foreground"
              to="/docs"
            >
              Documentation
            </Link>
            <a
              className="text-muted-foreground text-sm transition-colors hover:text-foreground"
              href="https://github.com/teyik0/furin"
              rel="noopener noreferrer"
              target="_blank"
            >
              GitHub
            </a>
          </div>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            <NavbarAuth />
          </div>
        </nav>
      </header>

      <main className="pt-16">{children}</main>

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
