// biome-ignore-all lint/performance/noJsxPropsBind: hero code tabs depend on local active tab state
import { useState } from "react";

const TAB_NAMES = ["server.ts", "pages/root.tsx", "pages/index.tsx"] as const;
type TabName = (typeof TAB_NAMES)[number];

export function HeroCodeWindow({ codeHtmlMap }: { codeHtmlMap: Record<TabName, string> }) {
  const [active, setActive] = useState<TabName>("server.ts");

  return (
    <div className="w-full max-w-lg overflow-hidden rounded-xl border border-zinc-700/50 shadow-2xl shadow-black/40">
      {/* Title bar with dots + tabs */}
      <div className="flex items-center gap-2 border-zinc-700/50 border-b bg-[#161b22] px-4 py-3">
        <span className="size-3 rounded-full bg-red-500/80" />
        <span className="size-3 rounded-full bg-yellow-500/80" />
        <span className="size-3 rounded-full bg-green-500/80" />
        <div className="ml-2 flex">
          {TAB_NAMES.map((name) => (
            <button
              className={`border-0 px-3 py-1 font-mono text-xs transition-colors ${
                active === name ? "bg-[#0d1117] text-zinc-200" : "text-zinc-500 hover:text-zinc-300"
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
      {/* react-doctor-disable-next-line react/no-danger, react-doctor/dangerous-html-sink */}
      <div
        className="[&>pre]:overflow-auto [&>pre]:bg-[#0d1117]! [&>pre]:p-6 [&>pre]:text-sm [&>pre]:leading-relaxed"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted Shiki syntax-highlighted output; never contains user input
        dangerouslySetInnerHTML={{ __html: codeHtmlMap[active] }}
      />
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
    <div className="rounded-xl border border-border bg-card p-8 transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-sm">
      <div className="mb-5 flex size-12 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
        {icon}
      </div>
      <h3 className="mb-3 font-semibold text-foreground text-lg">{title}</h3>
      <p className="text-muted-foreground leading-relaxed">{description}</p>
    </div>
  );
}
