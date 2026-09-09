import { defineRoute } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { codeToHtml } from "shiki";
import { FeatureCard, HeroCodeWindow } from "@/components/hero-section";
import {
  ApiIcon,
  CompileIcon,
  FileIcon,
  HmrIcon,
  LayoutIcon,
  PluginIcon,
  RenderIcon,
  TypeIcon,
} from "@/components/icons";
import { route as parentRoute } from "./root";

const FILES = {
  "pages/index.tsx": `import { defineRoute } from "@teyik0/furin"
import { route as rootRoute } from "./root"

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(async () => ({
    message: "Hello from Furin!",
  }))
  .page(({ data: { message } }) => (
    <h1>{message}</h1>
  ))`,
  "pages/root.tsx": `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin"
import { Link } from "@teyik0/furin/link"
import "./styles/globals.css"

function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav>
          <Link to="/">Home</Link>
          <Link to="/blog">Blog</Link>
        </nav>
        <main>{children}</main>
        <Scripts />
      </body>
    </html>
  )
}

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => <RootLayout>{children}</RootLayout>)`,
  "server.ts": `import { Elysia } from "elysia"
import { furin } from "@teyik0/furin"

const app = new Elysia()
  .use(await furin({ pagesDir: "./pages" }))
  .listen(3000)`,
} as const;

type FileName = keyof typeof FILES;

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .loader(async () => {
    const entries = Object.entries(FILES) as [FileName, string][];
    const codeHtmlMap = Promise.all(
      entries.map(async ([name, code]) => [
        name,
        await codeToHtml(code, { lang: "tsx", theme: "github-dark" }),
      ])
    ).then((resolvedEntries) => Object.fromEntries(resolvedEntries) as Record<FileName, string>);
    return { codeHtmlMap: await codeHtmlMap };
  })
  .head(() => ({
    links: [{ href: "/", rel: "canonical" }],
    meta: [{ title: "Furin — The Fast, Minimal React Framework for Bun" }],
  }))
  .page(({ data: { codeHtmlMap } }) => (
    <div>
      {/* Hero */}
      <section className="relative flex min-h-[calc(100vh-3.5rem)] items-center overflow-hidden bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(59,130,246,0.22),transparent)] dark:bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(59,130,246,0.12),transparent)]">
        {/* Grid overlay — uses currentColor so it flips with the theme */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.04] dark:opacity-[0.03]"
          style={{
            backgroundImage:
              "linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)",
            backgroundSize: "64px 64px",
          }}
        />

        <div className="relative mx-auto grid max-w-7xl grid-cols-1 gap-16 px-4 py-24 sm:px-6 lg:grid-cols-2 lg:px-8">
          {/* Left: headline */}
          <div className="flex flex-col justify-center">
            <h1 className="mb-6 font-semibold text-3xl text-foreground leading-[1.1] sm:text-6xl lg:text-[3.75rem]">
              Furin.{" "}
              <span className="text-muted-foreground">
                The Fast, Minimal, and Modern React Meta Framework for Bun.
              </span>
            </h1>

            <p className="max-w-lg text-lg text-muted-foreground leading-relaxed">
              Rethinking web development speed and simplicity with Bun.
            </p>
            <p className="mb-10 max-w-lg text-lg text-muted-foreground leading-relaxed">
              One unique process, frontend and backend with bun native HMR.
            </p>

            <div className="flex flex-wrap gap-4">
              <Link
                className="rounded-full bg-blue-600 px-8 py-3 font-medium text-sm text-white transition-[background-color,box-shadow] hover:bg-blue-500 hover:shadow-blue-500/25 hover:shadow-lg"
                to="/docs"
              >
                Get Started
              </Link>
              <a
                className="rounded-full border border-border px-8 py-3 font-medium text-foreground/70 text-sm transition-colors hover:border-foreground/40 hover:text-foreground"
                href="https://github.com/teyik0/furin"
                rel="noopener noreferrer"
                target="_blank"
              >
                View on GitHub
              </a>
            </div>
          </div>

          {/* Right: tabbed code window — intentionally always dark */}
          <div className="flex items-center justify-center">
            <HeroCodeWindow codeHtmlMap={codeHtmlMap} />
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-border border-t py-24">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <h2 className="mb-4 text-center font-semibold text-3xl text-foreground">
            Everything you need
          </h2>
          <p className="mb-12 text-center text-muted-foreground">
            A complete React meta-framework, batteries included.
          </p>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureCard
              description="Automatic route generation from your file structure. Dynamic routes, nested layouts, and catch-all patterns."
              icon={<FileIcon />}
              title="File-Based Routing"
            />
            <FeatureCard
              description="SSR for dynamic content, SSG for static pages, ISR for the best of both worlds."
              icon={<RenderIcon />}
              title="Multiple Rendering Modes"
            />
            <FeatureCard
              description="Complete TypeScript inference across the stack. No code generation required."
              icon={<TypeIcon />}
              title="Full Type Safety"
            />
            <FeatureCard
              description="Compose your UI with powerful layout patterns. Data flows flat through the component tree."
              icon={<LayoutIcon />}
              title="Nested Layouts"
            />
            <FeatureCard
              description="React Fast Refresh for instant feedback during development. Powered by Bun's speed."
              icon={<HmrIcon />}
              title="Fast Refresh"
            />
            <FeatureCard
              description="Build your backend alongside your frontend with Elysia's powerful API capabilities."
              icon={<ApiIcon />}
              title="API Routes"
            />
            <FeatureCard
              description='Compile to a standalone binary with Bun. "server" separates client assets; "embed" produces a single executable.'
              icon={<CompileIcon />}
              title="Bun Binary Compile"
            />
            <FeatureCard
              description="Pass Bun plugins (e.g. Tailwind, custom transforms) directly in furin.config.ts. They run before the internal client transform."
              icon={<PluginIcon />}
              title="User Plugins"
            />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-border border-t py-24">
        <div className="mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="mb-4 font-semibold text-3xl text-foreground">Ready to build?</h2>
          <p className="mb-10 text-lg text-muted-foreground">
            Explore the live demo or dive into the documentation.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link
              className="rounded-full bg-blue-600 px-8 py-3 font-medium text-sm text-white transition-[background-color,box-shadow] hover:bg-blue-500 hover:shadow-blue-500/25 hover:shadow-lg"
              to="/docs"
            >
              Explore Examples
            </Link>
            <Link
              className="rounded-full border border-border px-8 py-3 font-medium text-foreground/70 text-sm transition-colors hover:border-foreground/40 hover:text-foreground"
              to="/docs"
            >
              Read the Docs
            </Link>
          </div>
        </div>
      </section>
    </div>
  ));
