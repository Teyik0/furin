import type { PointerEvent } from "react";
import { Reveal } from "./reveal";

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

function track(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
  el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
  el.style.setProperty("--rx", `${((0.5 - y) * 7).toFixed(2)}deg`);
  el.style.setProperty("--ry", `${((x - 0.5) * 9).toFixed(2)}deg`);
}

function reset(e: PointerEvent<HTMLElement>) {
  e.currentTarget.style.setProperty("--rx", "0deg");
  e.currentTarget.style.setProperty("--ry", "0deg");
}

export function ModesGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {MODES.map((mode, i) => (
        <Reveal delay={i * 90} key={mode.key}>
          <article className="mode-card group" onPointerLeave={reset} onPointerMove={track}>
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
              <p className="mt-2 text-muted-foreground text-sm leading-relaxed">{mode.body}</p>
              <code className="mt-auto block pt-8 font-mono text-[12px] text-[var(--lp-accent)]">
                {mode.code}
              </code>
            </div>
          </article>
        </Reveal>
      ))}
    </div>
  );
}
