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
import { ChimeCanvas } from "@/components/landing/chime-canvas";
import { CopyCommand } from "@/components/landing/copy-command";
import { LandingFont } from "@/components/landing/landing-font";
import { ModesGrid } from "@/components/landing/modes-grid";
import { Reveal } from "@/components/landing/reveal";
import { StackReveal } from "@/components/landing/stack-reveal";
import { route as parentRoute } from "./root";

const FILES = {
  "pages/index.tsx": `import { defineRoute } from "@teyik0/furin"
import { route as rootRoute } from "./root"

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(async () => ({
    message: "Hello from Furin!",
    renderedAt: Date.now(),
  }))
  .page(({ message, renderedAt }) => (
    <h1>{message} · {renderedAt}</h1>
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

export const port = Number(process.env.PORT ?? 3000)

const app = new Elysia()
  .use(await furin({ pagesDir: "./pages" }))

if (import.meta.main) {
  app.listen(port)
  console.log(\`Furin app running at http://localhost:\${app.server?.port}\`)
}

export default app`,
} as const;

type FileName = keyof typeof FILES;

const FEATURES = [
  {
    description:
      "Automatic route generation from your file structure. Dynamic routes, nested layouts, and catch-all patterns.",
    icon: <FileIcon />,
    title: "File-Based Routing",
  },
  {
    description: "SSR for dynamic content, SSG for static pages, ISR for the best of both worlds.",
    icon: <RenderIcon />,
    title: "Multiple Rendering Modes",
  },
  {
    description: "Complete TypeScript inference across the stack. No code generation required.",
    icon: <TypeIcon />,
    title: "Full Type Safety",
  },
  {
    description:
      "Compose your UI with powerful layout patterns. Data flows flat through the component tree.",
    icon: <LayoutIcon />,
    title: "Nested Layouts",
  },
  {
    description:
      "React Fast Refresh for instant feedback during development. Powered by Bun's speed.",
    icon: <HmrIcon />,
    title: "Fast Refresh",
  },
  {
    description:
      "Build your backend alongside your frontend with Elysia's powerful API capabilities.",
    icon: <ApiIcon />,
    title: "API Routes",
  },
  {
    description:
      'Compile to a standalone binary with Bun. "server" separates client assets; "embed" produces a single executable.',
    icon: <CompileIcon />,
    title: "Bun Binary Compile",
  },
  {
    description:
      "Pass Bun plugins (e.g. Tailwind, custom transforms) directly in furin.config.ts. They run before the internal client transform.",
    icon: <PluginIcon />,
    title: "User Plugins",
  },
] as const;

function delay(ms: number) {
  return { "--d": `${ms}ms` } as React.CSSProperties;
}

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
    meta: [
      { title: "Furin — The React framework that rings fast" },
      {
        content:
          "Furin is a React meta-framework on Elysia and Bun: SSR, SSG and ISR per route, SPA navigation, end-to-end TypeScript inference, native HMR and single-binary compile.",
        name: "description",
      },
    ],
  }))
  .page(({ codeHtmlMap }) => (
    <div className="landing">
      <LandingFont />
      {/* 1 — Hero */}
      <section className="hero relative isolate flex min-h-[calc(100svh-3.5rem)] flex-col overflow-hidden">
        <ChimeCanvas className="-z-10" variant="hero" />
        <div className="hero-veil pointer-events-none absolute inset-0 -z-10" />

        <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col justify-end px-5 pt-[40svh] pb-14 sm:px-8 md:justify-center md:pt-24 md:pb-24">
          <div className="max-w-[46rem]">
            <p className="hero-in lp-eyebrow mb-7" style={delay(0)}>
              <span className="jp-mark">風鈴</span>
              <span className="mx-2 text-foreground/25">/</span>
              React · Elysia · Bun
            </p>
            <h1 className="hero-in hero-in--lcp lp-display mb-7">
              The React framework <span className="lp-display__accent">that rings fast.</span>
            </h1>
            <p
              className="hero-in mb-10 max-w-xl text-[17px] text-muted-foreground leading-relaxed sm:text-lg"
              style={delay(160)}
            >
              SSR, SSG &amp; ISR per route with SPA navigation — on Elysia and Bun, fully typed end
              to end.
            </p>
            <div className="hero-in flex flex-wrap items-center gap-3" style={delay(240)}>
              <Link className="lp-cta" to="/docs">
                Get started
                <span aria-hidden="true" className="lp-cta__arrow">
                  →
                </span>
              </Link>
              <CopyCommand />
            </div>
          </div>
        </div>

        <div className="relative mx-auto hidden w-full max-w-7xl items-center justify-between px-5 pb-8 font-mono text-[11px] text-muted-foreground uppercase tracking-[0.2em] sm:px-8 md:flex">
          <span className="motion-reduce:invisible">Click anywhere to ring</span>
          <span className="flex items-center gap-3">
            Scroll
            <span className="scroll-cue" />
          </span>
        </div>
      </section>

      {/* 2 — Stack */}
      <StackReveal />

      {/* 3 — Code + types */}
      <section className="relative py-24 sm:py-32">
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[0.9fr_1.1fr]">
          <Reveal className="min-w-0">
            <p className="lp-eyebrow mb-5">02 — Types</p>
            <h2 className="lp-h2 mb-6">
              Your loader is
              <br />
              <span className="text-muted-foreground">your props.</span>
            </h2>
            <p className="max-w-md text-muted-foreground leading-relaxed sm:text-lg">
              Whatever <code className="lp-code">.loader()</code> returns is inferred straight into{" "}
              <code className="lp-code">.page()</code> — across layouts, through Elysia, without a
              codegen step.
            </p>
          </Reveal>
          <Reveal className="type-reveal min-w-0" delay={120}>
            <HeroCodeWindow codeHtmlMap={codeHtmlMap} />
          </Reveal>
        </div>
      </section>

      {/* 4 — Rendering modes */}
      <section className="relative py-24 sm:py-32">
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <Reveal className="mb-14 max-w-2xl">
            <p className="lp-eyebrow mb-5">03 — Rendering</p>
            <h2 className="lp-h2">
              Pick a mode per route.
              <br />
              <span className="text-muted-foreground">Change it with one line.</span>
            </h2>
          </Reveal>
          <ModesGrid />
        </div>
      </section>

      {/* 5 — Features */}
      <section className="relative py-24 sm:py-32">
        <div className="mx-auto max-w-7xl px-5 sm:px-8">
          <Reveal className="mb-14 max-w-3xl">
            <p className="lp-eyebrow mb-5">04 — Batteries</p>
            <h2 className="lp-h2">
              Everything you need.
              <br />
              <span className="text-muted-foreground">Nothing you have to wire.</span>
            </h2>
          </Reveal>
          <div className="feature-grid grid sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((feature, i) => (
              <Reveal delay={(i % 4) * 70} key={feature.title}>
                <FeatureCard
                  description={feature.description}
                  icon={feature.icon}
                  title={feature.title}
                />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* 6 — Final CTA */}
      <section className="relative isolate overflow-hidden py-24 sm:py-32">
        <div className="mx-auto flex max-w-3xl flex-col items-center px-5 text-center sm:px-8">
          <div className="relative mb-4 h-72 w-56">
            <ChimeCanvas ringOnEnter variant="mini" />
          </div>
          <Reveal>
            <h2 className="lp-h2 mb-5">Hear it ring.</h2>
            <p className="mx-auto mb-10 max-w-md text-muted-foreground sm:text-lg">
              One command, one process, one binary. Start building in under a minute.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link className="lp-cta" to="/docs">
                Read the docs
                <span aria-hidden="true" className="lp-cta__arrow">
                  →
                </span>
              </Link>
              <CopyCommand />
            </div>
          </Reveal>
        </div>
      </section>
    </div>
  ));
