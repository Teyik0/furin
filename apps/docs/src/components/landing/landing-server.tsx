import type { Link as LinkComponent } from "@teyik0/furin/link";
import { type ComponentProps, type CSSProperties, type ReactNode, Suspense } from "react";
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
import { FeatureCard, type HeroCodeWindow as HeroCodeWindowComponent } from "../hero-section";
import type { ChimeCanvas as ChimeCanvasComponent } from "./chime-canvas";
import type { CopyCommand as CopyCommandComponent } from "./copy-command";
import type { ModeCard as ModeCardComponent } from "./modes-grid";
import type { Reveal as RevealComponent } from "./reveal";
import { ShipSection } from "./ship-section";
import type { StackReveal as StackRevealComponent } from "./stack-reveal";
import { SyncSection } from "./sync-section";

export interface LandingSlots {
  ChimeCanvas: (props: ComponentProps<typeof ChimeCanvasComponent>) => ReactNode;
  CopyCommand: (props: ComponentProps<typeof CopyCommandComponent>) => ReactNode;
  HeroCodeWindow: (props: ComponentProps<typeof HeroCodeWindowComponent>) => ReactNode;
  LandingFont: () => ReactNode;
  Link: (props: ComponentProps<typeof LinkComponent>) => ReactNode;
  ModeCard: (props: ComponentProps<typeof ModeCardComponent>) => ReactNode;
  Reveal: (props: ComponentProps<typeof RevealComponent>) => ReactNode;
  StackReveal: (props: ComponentProps<typeof StackRevealComponent>) => ReactNode;
  SyncDemo: () => ReactNode;
}

interface LandingServerProps {
  codeHtmlMap: ComponentProps<typeof HeroCodeWindowComponent>["codeHtmlMap"];
  hintPosition: ComponentProps<typeof HeroCodeWindowComponent>["hintPosition"];
  slots: LandingSlots;
  syncClientHtml: string;
  syncServerHtml: string;
}

const LAYERS = [
  {
    detail: "Streaming SSR · hydration · nested layouts · Fast Refresh",
    glow: "rgb(97 218 251 / 0.22)",
    hue: "#61dafb",
    name: "React",
    role: "UI",
  },
  {
    detail: "Routing · validation · guards · end-to-end types",
    glow: "rgb(167 139 250 / 0.22)",
    hue: "#a78bfa",
    name: "Elysia",
    role: "Server",
  },
  {
    detail: "Bundler · native HMR · single-binary compile",
    glow: "rgb(233 184 106 / 0.24)",
    hue: "#e9b86a",
    name: "Bun",
    role: "Runtime",
  },
] as const;

const MODES = [
  {
    body: "Fresh HTML streamed on every request, loaders run next to your Elysia handlers.",
    code: 'mode: "ssr"',
    key: "SSR",
    title: "Server-side rendering",
  },
  {
    body: "Pre-rendered at build time. Ship to any CDN — this site is one.",
    code: 'mode: "ssg"',
    key: "SSG",
    title: "Static generation",
  },
  {
    body: "Static speed, revalidated in the background on your schedule.",
    code: 'mode: "isr", revalidate: 60',
    key: "ISR",
    title: "Incremental static",
  },
  {
    body: "Every route hydrates into an SPA: <Link> fetches loader data, not documents.",
    code: '<Link to="/docs" />',
    key: "SPA",
    title: "Client navigation",
  },
] as const;

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

export function LandingServer({
  codeHtmlMap,
  hintPosition,
  syncClientHtml,
  syncServerHtml,
  slots,
}: LandingServerProps) {
  const {
    ChimeCanvas,
    CopyCommand,
    LandingFont,
    HeroCodeWindow,
    ModeCard,
    Reveal,
    StackReveal,
    Link,
    SyncDemo,
  } = slots;
  return (
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
            <h1 className="hero-in lp-display mb-7" style={delay(60)}>
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

      {/* Everything below the hero hydrates as its own boundary (React selective hydration),
          so the first hydration task only covers the shell and the hero. */}
      <Suspense fallback={null}>
        {/* 2 — Stack */}
        <StackReveal>
          <div className="sticky top-14 flex h-[calc(100svh-3.5rem)] items-center overflow-hidden">
            <div className="mx-auto grid w-full max-w-7xl items-center gap-10 px-5 sm:px-8 lg:grid-cols-[1fr_1.15fr]">
              <div className="relative z-10">
                <p className="lp-eyebrow mb-5">01 — The stack</p>
                <h2 className="lp-h2 mb-6">
                  Three layers.
                  <br />
                  <span className="text-muted-foreground">One process.</span>
                </h2>
                <p className="max-w-md text-base text-muted-foreground leading-relaxed sm:text-lg">
                  Frontend and backend share a single Bun process. Elysia serves your pages as a
                  plugin, React renders them — and your types cross every boundary.
                </p>
                <ol className="sr-only mt-10 space-y-3 font-mono text-[13px] sm:not-sr-only">
                  {LAYERS.toReversed().map((layer, i) => (
                    <li
                      className="stack-step flex items-center gap-3"
                      key={layer.name}
                      style={{ "--i": i } as CSSProperties}
                    >
                      <span
                        className="size-1.5 rounded-full"
                        style={{ background: layer.hue, boxShadow: `0 0 12px ${layer.hue}` }}
                      />
                      <span className="text-foreground">{layer.name}</span>
                      <span className="text-muted-foreground">/ {layer.role}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div aria-hidden="true" className="stack-stage relative h-[46svh] sm:h-[60svh]">
                <div className="stack-rig absolute top-1/2 left-1/2">
                  {LAYERS.map((layer, idx) => {
                    // bottom layer (Bun) arrives first
                    const order = LAYERS.length - 1 - idx;
                    return (
                      <div
                        className="stack-slab"
                        key={layer.name}
                        style={
                          {
                            "--hue": layer.hue,
                            "--hue-glow": layer.glow,
                            "--i": order,
                          } as CSSProperties
                        }
                      >
                        <div className="flex items-start justify-between">
                          <span className="font-mono text-[11px] text-foreground/50 uppercase tracking-[0.2em]">
                            {String(order + 1).padStart(2, "0")} · {layer.role}
                          </span>
                          <span
                            className="size-2 rounded-full"
                            style={{ background: layer.hue, boxShadow: `0 0 18px ${layer.hue}` }}
                          />
                        </div>
                        <div>
                          <p className="font-semibold text-3xl text-foreground tracking-[-0.03em] sm:text-4xl">
                            {layer.name}
                          </p>
                          <p className="mt-2 text-[13px] text-foreground/60">{layer.detail}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </StackReveal>

        {/* 3 — Code + types */}
        <section className="lp-defer relative py-24 sm:py-32">
          <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-[0.9fr_1.1fr]">
            <Reveal className="min-w-0">
              <p className="lp-eyebrow mb-5">02 — Types</p>
              <h2 className="lp-h2 mb-6">
                Your loader is
                <br />
                <span className="text-muted-foreground">your props.</span>
              </h2>
              <p className="max-w-md text-muted-foreground leading-relaxed sm:text-lg">
                Whatever <code className="lp-code">.loader()</code> returns is inferred straight
                into <code className="lp-code">.page()</code> — across layouts, through Elysia,
                without a codegen step.
              </p>
            </Reveal>
            <Reveal className="type-reveal min-w-0" delay={120}>
              <HeroCodeWindow codeHtmlMap={codeHtmlMap} hintPosition={hintPosition} />
            </Reveal>
          </div>
        </section>

        {/* 4 — Rendering modes */}
        <section className="lp-defer relative py-24 sm:py-32">
          <div className="mx-auto max-w-7xl px-5 sm:px-8">
            <Reveal className="mb-14 max-w-2xl">
              <p className="lp-eyebrow mb-5">03 — Rendering</p>
              <h2 className="lp-h2">
                Pick a mode per route.
                <br />
                <span className="text-muted-foreground">Change it with one line.</span>
              </h2>
            </Reveal>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {MODES.map((mode, i) => (
                <Reveal delay={i * 90} key={mode.key}>
                  <ModeCard>
                    <div className="mode-card__glow" />
                    <div className="relative flex h-full flex-col">
                      <div className="flex items-baseline justify-between">
                        <span className="font-semibold text-5xl text-foreground tracking-[-0.05em]">
                          {mode.key}
                        </span>
                        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                          0{i + 1}
                        </span>
                      </div>
                      <h3 className="mt-10 font-medium text-foreground">{mode.title}</h3>
                      <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
                        {mode.body}
                      </p>
                      <code className="mt-auto block pt-8 font-mono text-[12px] text-[var(--lp-accent)]">
                        {mode.code}
                      </code>
                    </div>
                  </ModeCard>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Sync + ship (from the motion video) */}
        <SyncSection
          clientHtml={syncClientHtml}
          Link={Link}
          Reveal={Reveal}
          SyncDemo={SyncDemo}
          serverHtml={syncServerHtml}
        />
        <ShipSection Link={Link} Reveal={Reveal} />

        {/* 5 — Features */}
        <section className="lp-defer relative py-24 sm:py-32">
          <div className="mx-auto max-w-7xl px-5 sm:px-8">
            <Reveal className="mb-14 max-w-3xl">
              <p className="lp-eyebrow mb-5">06 — Batteries</p>
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
        <section className="lp-defer relative isolate overflow-hidden py-24 sm:py-32">
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
      </Suspense>
    </div>
  );
}
