import { type CSSProperties, useEffect, useRef } from "react";

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

/**
 * Sticky scroll scene: three glass slabs assemble into one stack as the section
 * scrolls through the viewport. Progress is written to a single CSS variable
 * (`--p`) per frame; every transform is derived in CSS. No scroll hijacking —
 * the page scrolls natively, the stage is just `position: sticky`.
 */
export function StackReveal() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el?.style.setProperty("--p", "1");
      return;
    }
    let raf = 0;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const total = rect.height - window.innerHeight;
      const p = Math.min(1, Math.max(0, -rect.top / Math.max(total, 1)));
      el.style.setProperty("--p", p.toFixed(4));
    };
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <section className="stack-section relative h-[200vh] md:h-[230vh]" ref={ref}>
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
              Frontend and backend share a single Bun process. Elysia serves your pages as a plugin,
              React renders them — and your types cross every boundary.
            </p>
            <ol className="mt-10 hidden space-y-3 font-mono text-[13px] sm:block">
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
    </section>
  );
}
