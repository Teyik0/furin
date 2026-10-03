import { type ReactNode, useEffect, useRef } from "react";

/**
 * Sticky scroll scene: three glass slabs assemble into one stack as the section
 * scrolls through the viewport. Progress is written to a single CSS variable
 * (`--p`) per frame; every transform is derived in CSS. No scroll hijacking —
 * the page scrolls natively, the stage is just `position: sticky`.
 */
export function StackReveal({ children }: { children: ReactNode }) {
  "use no memo";
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
    <section className="lp-defer stack-section relative h-[200vh] md:h-[230vh]" ref={ref}>
      {children}
    </section>
  );
}
