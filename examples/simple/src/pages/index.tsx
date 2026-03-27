import { Link } from "@teyik0/furin/link";
import { useState } from "react";
import { codeToHtml } from "shiki";
import { route } from "./root";

const FILES = {
  "server.ts": `import { Elysia } from "elysia"
import { furin } from "@teyik0/furin"

const app = new Elysia()
  .use(await furin({ pagesDir: "./pages" }))
  .listen(3000)`,
  "pages/root.tsx": `import { createRoute } from "@teyik0/furin/client"
import { Link } from "@teyik0/furin/link"
import "./styles/globals.css"

function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/blog">Blog</Link>
      </nav>
      <main>{children}</main>
    </>
  )
}

export const route = createRoute({
  layout: ({ children }) => <RootLayout>{children}</RootLayout>,
})`,
  "pages/index.tsx": `import { route } from "./root"

export default route.page({
  loader: async () => ({
    message: "Hello from Furin!",
  }),
  component: ({ message }) => (
    <h1>{message}</h1>
  ),
})`,
} as const;

type FileName = keyof typeof FILES;

export default route.page({
  head: () => ({
    meta: [{ title: "Furin — The Fast, Minimal React Framework for Bun" }],
    links: [{ rel: "canonical", href: "/" }],
  }),
  loader: async () => {
    const entries = Object.entries(FILES) as [FileName, string][];
    const codeHtmlMap = Object.fromEntries(
      await Promise.all(
        entries.map(async ([name, code]) => [
          name,
          await codeToHtml(code, { lang: "tsx", theme: "github-dark" }),
        ])
      )
    ) as Record<FileName, string>;
    return { codeHtmlMap };
  },
  component: ({ codeHtmlMap }) => (
    <div>
      {/* Hero */}
      <section className="relative flex min-h-[calc(100vh-4rem)] items-center overflow-hidden bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(59,130,246,0.22),transparent)] dark:bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(59,130,246,0.12),transparent)]">
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
            <div className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 font-medium text-blue-500 text-xs dark:text-blue-400">
              <span className="h-1.5 w-1.5 rounded-full bg-blue-500 dark:bg-blue-400" />
              Open Source · v0.1
            </div>

            <h1 className="mb-6 font-bold text-3xl text-foreground leading-[1.1] sm:text-6xl lg:text-[3.75rem]">
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
                className="rounded-full bg-blue-600 px-8 py-3 font-medium text-sm text-white transition-all hover:bg-blue-500 hover:shadow-blue-500/25 hover:shadow-lg"
                to="/docs"
              >
                Get Started
              </Link>
              <a
                className="rounded-full border border-border px-8 py-3 font-medium text-foreground/70 text-sm transition-all hover:border-foreground/40 hover:text-foreground"
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
          <h2 className="mb-4 text-center font-bold text-3xl text-foreground">
            Everything you need
          </h2>
          <p className="mb-12 text-center text-muted-foreground">
            A complete React meta-framework — batteries included.
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
          <h2 className="mb-4 font-bold text-3xl text-foreground">Ready to build?</h2>
          <p className="mb-10 text-lg text-muted-foreground">
            Explore the live demo or dive into the documentation.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link
              className="rounded-full bg-blue-600 px-8 py-3 font-medium text-sm text-white transition-all hover:bg-blue-500 hover:shadow-blue-500/25 hover:shadow-lg"
              to="/docs"
            >
              Explore Examples
            </Link>
            <Link
              className="rounded-full border border-border px-8 py-3 font-medium text-foreground/70 text-sm transition-all hover:border-foreground/40 hover:text-foreground"
              to="/docs"
            >
              Read the Docs
            </Link>
          </div>
        </div>
      </section>
    </div>
  ),
});

const TAB_NAMES: FileName[] = ["server.ts", "pages/root.tsx", "pages/index.tsx"];

function HeroCodeWindow({ codeHtmlMap }: { codeHtmlMap: Record<FileName, string> }) {
  const [active, setActive] = useState<FileName>("server.ts");

  return (
    <div className="w-full max-w-lg overflow-hidden rounded-xl border border-slate-700/50 shadow-2xl shadow-black/40">
      {/* Title bar with dots + tabs */}
      <div className="flex items-center gap-2 border-slate-700/50 border-b bg-[#161b22] px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-red-500/80" />
        <span className="h-3 w-3 rounded-full bg-yellow-500/80" />
        <span className="h-3 w-3 rounded-full bg-green-500/80" />
        <div className="ml-2 flex">
          {TAB_NAMES.map((name) => (
            <button
              className={`border-0 px-3 py-1 font-mono text-xs transition-colors ${
                active === name
                  ? "bg-[#0d1117] text-slate-200"
                  : "text-slate-500 hover:text-slate-300"
              } ${name === TAB_NAMES[0] ? "rounded-l-md" : ""} ${name === TAB_NAMES.at(-1) ? "rounded-r-md" : ""}`}
              key={name}
              onClick={() => setActive(name)}
              type="button"
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      {/* Code content */}
      <div
        className="[&>pre]:overflow-auto [&>pre]:bg-[#0d1117]! [&>pre]:p-6 [&>pre]:text-sm [&>pre]:leading-relaxed"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted shiki output
        dangerouslySetInnerHTML={{ __html: codeHtmlMap[active] }}
      />
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-8 transition-all hover:border-foreground/20 hover:shadow-sm">
      <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
        {icon}
      </div>
      <h3 className="mb-3 font-semibold text-foreground text-lg">{title}</h3>
      <p className="text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}

function FileIcon() {
  return (
    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <title>File-Based Routing</title>
      <path
        d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function RenderIcon() {
  return (
    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <title>Multiple Rendering Modes</title>
      <path
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function TypeIcon() {
  return (
    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <title>Full Type Safety</title>
      <path
        d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function LayoutIcon() {
  return (
    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <title>Nested Layouts</title>
      <path
        d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function HmrIcon() {
  return (
    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <title>Fast Refresh</title>
      <path
        d="M13 10V3L4 14h7v7l9-11h-7z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function ApiIcon() {
  return (
    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <title>API Routes</title>
      <path
        d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function CompileIcon() {
  return (
    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <title>Bun Binary Compile</title>
      <path
        d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}

function PluginIcon() {
  return (
    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <title>User Plugins</title>
      <path
        d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
    </svg>
  );
}
