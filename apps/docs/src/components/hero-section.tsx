// biome-ignore-all lint/performance/noJsxPropsBind: hero code tabs depend on local active tab state
import { useState } from "react";

const TAB_NAMES = ["pages/index.tsx", "pages/root.tsx", "server.ts"] as const;
type TabName = (typeof TAB_NAMES)[number];

/** Zero-based line of `.page(({ ... }) =>` in the pages/index.tsx sample; the hint sits beside it. */
const HINT_LINE = 9;
/** Monospace column just past the end of that line. */
const HINT_COLUMN = 41;
const LINE_HEIGHT = "calc(13px * 1.7)";

export function HeroCodeWindow({ codeHtmlMap }: { codeHtmlMap: Record<TabName, string> }) {
  const [active, setActive] = useState<TabName>("pages/index.tsx");

  return (
    <div className="code-glass relative w-full overflow-hidden rounded-2xl">
      {/* Title bar with dots + tabs */}
      <div className="flex items-center gap-2 border-white/[0.07] border-b px-4 py-3">
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
        <span className="size-2.5 rounded-full bg-white/15" />
        <div className="ml-3 flex gap-1 overflow-x-auto" role="tablist">
          {TAB_NAMES.map((name) => (
            <button
              aria-selected={active === name}
              className={`shrink-0 rounded-md px-2.5 py-1 font-mono text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-[var(--lp-accent)] ${
                active === name
                  ? "bg-white/[0.08] text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
              key={name}
              onClick={() => setActive(name)}
              role="tab"
              type="button"
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className="relative">
        {active === "pages/index.tsx" && (
          <div
            className="type-hint-line pointer-events-none absolute inset-x-0 max-sm:hidden"
            style={{ height: LINE_HEIGHT, top: `calc(1.5rem + ${HINT_LINE} * ${LINE_HEIGHT})` }}
          />
        )}
        {/* Code content */}
        {/* react-doctor-disable-next-line react/no-danger, react-doctor/dangerous-html-sink */}
        <div
          className="relative [&>pre]:overflow-auto [&>pre]:bg-transparent! [&>pre]:p-6 [&>pre]:font-mono [&>pre]:text-[13px] [&>pre]:leading-[1.7]"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted Shiki syntax-highlighted output; never contains user input
          dangerouslySetInnerHTML={{ __html: codeHtmlMap[active] }}
        />
        {active === "pages/index.tsx" && (
          <div
            className="pointer-events-none absolute -translate-y-1/2 font-mono text-[13px] max-sm:hidden"
            style={{
              left: `calc(1.5rem + ${HINT_COLUMN}ch)`,
              top: `calc(1.5rem + ${HINT_LINE + 0.5} * ${LINE_HEIGHT})`,
            }}
          >
            <div className="type-hint type-hint__box text-[12px]">
              <span className="text-sky-300">(parameter)</span>{" "}
              <span className="text-zinc-100">data</span>
              <span className="text-zinc-500">: {"{"}</span>
              <div className="pl-4">
                <span className="text-zinc-100">message</span>
                <span className="text-zinc-500">: </span>
                <span className="text-teal-300">string</span>
                <span className="text-zinc-500">;</span>
              </div>
              <div className="pl-4">
                <span className="text-zinc-100">renderedAt</span>
                <span className="text-zinc-500">: </span>
                <span className="text-teal-300">number</span>
                <span className="text-zinc-500">;</span>
              </div>
              <span className="text-zinc-500">{"}"}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="feature-card h-full">
      <div className="mb-6 flex size-10 items-center justify-center rounded-lg border border-foreground/10 bg-foreground/[0.03] text-[var(--lp-accent)] [&_svg]:size-5">
        {icon}
      </div>
      <h3 className="mb-2 font-medium text-[15px] text-foreground">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
    </div>
  );
}
