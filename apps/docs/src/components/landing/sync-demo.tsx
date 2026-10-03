import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const COLUMNS = ["Todo", "In progress", "Done"] as const;
const STATIC_CARDS = [
  { col: 0, title: "Set up observability" },
  { col: 1, title: "Design API schema" },
  { col: 2, title: "Project scaffolding" },
] as const;

type Who = "alice" | "bob";
type Chip = "live" | "optimistic" | "synced";

interface Step {
  actor: Who;
  /** Column of the moving card in each tab. */
  alice: number;
  bob: number;
  /** optimistic: only the actor's tab has moved; synced: the other tab followed. */
  phase: "optimistic" | "synced";
}

// Alice: Todo → In progress, Bob: In progress → Done, Alice: Done → Todo (loops seamlessly).
const STEPS: readonly Step[] = [
  { actor: "alice", alice: 1, bob: 0, phase: "optimistic" },
  { actor: "alice", alice: 1, bob: 1, phase: "synced" },
  { actor: "bob", alice: 1, bob: 2, phase: "optimistic" },
  { actor: "bob", alice: 2, bob: 2, phase: "synced" },
  { actor: "alice", alice: 0, bob: 2, phase: "optimistic" },
  { actor: "alice", alice: 0, bob: 0, phase: "synced" },
];
const HOLD_MS = { optimistic: 900, synced: 1700 } as const;
/** Shown under prefers-reduced-motion: Alice moved the card, Bob's tab followed. */
const STATIC_STEP = 1;

function chipFor(step: Step, who: Who): Chip {
  if (step.actor === who) {
    return "optimistic";
  }
  return step.phase === "synced" ? "synced" : "live";
}

function Board({ who, step, active }: { who: Who; step: Step; active: boolean }) {
  "use no memo";
  const chip = chipFor(step, who);
  const moving = step.actor === who && step.phase === "optimistic";
  return (
    <div className="sync-window">
      <div className="flex items-center gap-2 border-white/[0.07] border-b px-3 py-2.5">
        <span
          className="size-2 rounded-full"
          style={{ background: who === "alice" ? "#c4b5fd" : "#fcd34d" }}
        />
        <span className="font-medium text-[13px] text-zinc-100">
          {who === "alice" ? "Alice" : "Bob"}
        </span>
        <span className="hidden truncate font-mono text-[11px] text-zinc-500 sm:inline">
          /board/project-alpha
        </span>
        <span
          className={cn("sync-chip ml-auto", `sync-chip--${chip}`)}
          data-active={active ? "" : undefined}
        >
          {chip === "optimistic" && "⚡ optimistic"}
          {chip === "synced" && "synced"}
          {chip === "live" && "live"}
        </span>
      </div>
      <div className="p-3">
        <div className="mb-2 grid grid-cols-3 gap-2">
          {COLUMNS.map((name) => (
            <span
              className="truncate font-mono text-[10px] text-zinc-500 uppercase tracking-[0.14em]"
              key={name}
            >
              {name}
            </span>
          ))}
        </div>
        <div className="sync-lanes">
          {STATIC_CARDS.map((card) => (
            <div
              className="sync-card"
              key={card.title}
              style={{ "--c": card.col, "--r": 0 } as CSSProperties}
            >
              {card.title}
            </div>
          ))}
          <div
            className={cn("sync-card sync-card--mover", moving && "sync-card--dragging")}
            style={{ "--c": who === "alice" ? step.alice : step.bob, "--r": 1 } as CSSProperties}
          >
            Compile to a single binary
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Two tabs on the same board: a card move renders immediately in the actor's tab
 * (optimistic) and then appears in the other tab once the invalidation lands (synced).
 * Pure DOM/CSS; the loop only runs while the demo is on screen.
 */
export function SyncDemo() {
  "use no memo";
  const ref = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(STATIC_STEP);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const io = new IntersectionObserver(([entry]) => setActive(Boolean(entry?.isIntersecting)), {
      threshold: 0.35,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }
    const step = STEPS[index] as Step;
    const id = window.setTimeout(
      () => setIndex((i) => (i + 1) % STEPS.length),
      HOLD_MS[step.phase]
    );
    return () => window.clearTimeout(id);
  }, [active, index]);

  const step = STEPS[index] as Step;
  return (
    <div className="relative" ref={ref}>
      <div className="grid gap-4 md:grid-cols-2">
        <Board active={active} step={step} who="alice" />
        <Board active={active} step={step} who="bob" />
      </div>
      <p aria-live="off" className="mt-4 text-center font-mono text-[12px] text-muted-foreground">
        {step.phase === "optimistic" ? (
          <>
            <span className="text-foreground">PATCH /api/cards/:id</span> · Idempotency-Key ·
            rendered before the server answers
          </>
        ) : (
          <>
            invalidates <span className="text-foreground">board</span> · every tab on that read
            follows
          </>
        )}
      </p>
    </div>
  );
}
