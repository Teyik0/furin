import type { BoardStats } from "@/api/modules/boards/service";

export function StatsBarSkeleton() {
  return (
    <div className="flex h-9 shrink-0 animate-pulse items-center gap-5 border-white/5 border-b bg-white/1 px-6">
      <div className="h-5 w-20 rounded-full bg-white/8" />
      <div className="h-3 w-px bg-white/8" />
      <div className="flex gap-5">
        {Array.from({ length: 4 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
          <div className="h-3 w-14 rounded bg-white/8" key={i} />
        ))}
      </div>
      <div className="h-3 w-px bg-white/8" />
      <div className="h-3 w-20 rounded bg-white/8" />
      <div className="ml-auto h-3 w-32 rounded bg-white/8" />
    </div>
  );
}

const COLUMN_COLORS = {
  backlog: "text-zinc-400",
  doing: "text-amber-400",
  done: "text-emerald-400",
  todo: "text-blue-400",
} as const;

export function StatsBar({
  cards,
  stats: initialStats,
}: {
  cards?: readonly { column: keyof BoardStats["byColumn"] }[];
  stats: BoardStats;
}) {
  let stats = initialStats;
  if (cards) {
    const byColumn = { backlog: 0, doing: 0, done: 0, todo: 0 };
    for (const card of cards) {
      byColumn[card.column] += 1;
    }
    stats = {
      byColumn,
      total: cards.length,
      completionRate: cards.length > 0 ? Math.round((byColumn.done / cards.length) * 100) : 0,
    };
  }
  return (
    <div className="flex h-9 shrink-0 items-center gap-5 border-white/5 border-b bg-white/1 px-6">
      <div className="flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/8 px-2.5 py-1">
        <span className="size-1.5 rounded-full bg-blue-400" />
        <span className="font-medium text-blue-300 text-xs">SSR</span>
      </div>

      <span className="h-3 w-px bg-white/8" />

      {(["backlog", "todo", "doing", "done"] as const).map((col) => (
        <div className="flex items-center gap-1.5" key={col}>
          <span className="text-xs text-zinc-600 capitalize">{col}</span>
          <span className={`font-bold text-xs ${COLUMN_COLORS[col]}`}>{stats.byColumn[col]}</span>
        </div>
      ))}

      <span className="h-3 w-px bg-white/8" />

      <span className="font-medium text-emerald-400 text-xs">{stats.completionRate}% done</span>

      <span className="ml-auto text-xs text-zinc-700">
        via{" "}
        <code className="rounded bg-white/5 px-1 font-mono text-violet-400 text-xs">loader</code>
      </span>
    </div>
  );
}

export function StatsBarUnavailable() {
  return (
    <div className="flex h-9 shrink-0 items-center border-white/5 border-b bg-white/1 px-6">
      <p className="text-xs text-zinc-500">Board stats are temporarily unavailable.</p>
    </div>
  );
}
