import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";
import type { ChimeScene } from "./chime-scene";

// Start downloading the three.js chunk as soon as this route module evaluates in the
// browser, so it overlaps hydration instead of waiting for the mount effect.
const sceneModule = typeof window === "undefined" ? null : import("./chime-scene");
sceneModule?.catch(() => {
  // Handled where it is awaited (the CSS poster stays); this only avoids an unhandled rejection.
});

interface ChimeCanvasProps {
  className?: string;
  /** Ring once the first time the canvas scrolls into view. */
  ringOnEnter?: boolean;
  variant: "hero" | "mini";
}

function pickParticleCount(variant: ChimeCanvasProps["variant"]): number {
  if (variant === "mini") {
    return 2500;
  }
  const narrow = window.matchMedia("(max-width: 767px)").matches;
  const lowPower = (navigator.hardwareConcurrency ?? 8) <= 4;
  if (narrow || lowPower) {
    return 10_000;
  }
  return 30_000;
}

/**
 * Client-only WebGL wind chime. The server (and no-WebGL clients) render only
 * the CSS poster; three.js is fetched as a separate chunk after hydration.
 * Pointer/click/scroll are read from the closest <section>, so the canvas can
 * stay `pointer-events: none` underneath real DOM content.
 */
export function ChimeCanvas({ variant, className, ringOnEnter = false }: ChimeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<ChimeScene | null>(null);
  const [ready, setReady] = useState(false);
  const { theme } = useTheme();
  // Read by the async scene bootstrap; kept current by the theme effect below.
  const themeRef = useRef(theme);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.closest("section");
    if (!(canvas && host)) {
      return;
    }
    const animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let disposed = false;
    let hasEntered = false;
    const cleanups: Array<() => void> = [];

    const boot = async () => {
      const { createChimeScene } = await (sceneModule ?? import("./chime-scene"));
      if (disposed) {
        return;
      }
      const scene = await createChimeScene(canvas, {
        animate,
        onFirstFrame: () => setReady(true),
        particleCount: pickParticleCount(variant),
        theme: themeRef.current,
        variant,
      });
      if (disposed) {
        scene.dispose();
        return;
      }
      sceneRef.current = scene;
      cleanups.push(() => scene.dispose());

      const io = new IntersectionObserver(
        ([entry]) => {
          if (!entry) {
            return;
          }
          scene.setActive(entry.isIntersecting);
          if (ringOnEnter && entry.intersectionRatio > 0.55 && !hasEntered) {
            hasEntered = true;
            const ringTimer = window.setTimeout(() => scene.ring(1), 350);
            cleanups.push(() => window.clearTimeout(ringTimer));
          }
        },
        { threshold: [0, 0.6] }
      );
      io.observe(canvas);
      cleanups.push(() => io.disconnect());

      const ro = new ResizeObserver(() => scene.resize());
      ro.observe(canvas);
      cleanups.push(() => ro.disconnect());

      if (variant !== "hero") {
        return;
      }
      const onMove = (e: PointerEvent) => scene.setPointer(e.clientX, e.clientY);
      const onLeave = () => scene.clearPointer();
      const onClick = (e: MouseEvent) => {
        if ((e.target as Element).closest("a, button, pre, input")) {
          return;
        }
        scene.ring(1, e.clientX, e.clientY);
      };
      let scrollRaf = 0;
      const onScroll = () => {
        cancelAnimationFrame(scrollRaf);
        scrollRaf = requestAnimationFrame(() => {
          const rect = host.getBoundingClientRect();
          scene.setScroll(Math.min(1, Math.max(0, -rect.top / rect.height)));
        });
      };
      host.addEventListener("pointermove", onMove, { passive: true });
      host.addEventListener("pointerleave", onLeave);
      host.addEventListener("click", onClick);
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
      // Greet the visitor with a single ring shortly after the first frame.
      const greet = window.setTimeout(() => scene.ring(0.9), 1100);
      cleanups.push(() => {
        host.removeEventListener("pointermove", onMove);
        host.removeEventListener("pointerleave", onLeave);
        host.removeEventListener("click", onClick);
        window.removeEventListener("scroll", onScroll);
        cancelAnimationFrame(scrollRaf);
        window.clearTimeout(greet);
      });
    };

    // Build lazily: the final-CTA chime would otherwise create a second WebGL context,
    // environment map and program set during the initial load.
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) {
          return;
        }
        near.disconnect();
        boot().catch(() => {
          // WebGL unavailable or chunk failed: the CSS poster remains, which is the intended fallback.
        });
      },
      { rootMargin: "50% 0px" }
    );
    near.observe(canvas);

    return () => {
      disposed = true;
      near.disconnect();
      sceneRef.current = null;
      for (const fn of cleanups.reverse()) {
        fn();
      }
    };
  }, [variant, ringOnEnter]);

  useEffect(() => {
    themeRef.current = theme;
    sceneRef.current?.setTheme(theme);
  }, [theme]);

  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0", className)}>
      <div className={cn("chime-poster absolute inset-0", `chime-poster--${variant}`)} />
      <canvas
        className={cn(
          "absolute inset-0 size-full transition-opacity duration-[1400ms] ease-out",
          ready ? "opacity-100" : "opacity-0"
        )}
        ref={canvasRef}
      />
    </div>
  );
}
