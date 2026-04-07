import { Suspense, use, useCallback, useMemo, useState } from "react";
import type { BoardStats } from "@/api/modules/boards/service";
import { getBoardData } from "@/api/modules/boards/service";
import { apiClient } from "@/lib/api";
import { Kanban, type KanbanCard } from "../../../components/ui/kanban";
import { route } from "../_route";

// ---------------------------------------------------------------------------
// Stats fetch via Eden treaty — fully typed, same client as the rest of the app
// Never rejects: resolves to null on error so Suspense never crashes.
// ---------------------------------------------------------------------------

async function fetchBoardStats(boardId: string): Promise<BoardStats | null> {
  const { data, error } = await apiClient.api.boards({ boardId }).stats.get();
  if (error) {
    return null;
  }
  return data as BoardStats;
}

// ---------------------------------------------------------------------------
// StatsBar skeleton — flushed in the very first HTML chunk
// ---------------------------------------------------------------------------

function StatsBarSkeleton() {
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

// ---------------------------------------------------------------------------
// StatsBar — suspends until the /stats endpoint responds.
// Receives the promise as a prop for a stable reference across re-renders.
// ---------------------------------------------------------------------------

const COLUMN_COLORS = {
  backlog: "text-slate-400",
  todo: "text-blue-400",
  doing: "text-amber-400",
  done: "text-emerald-400",
} as const;

function StatsBar({ statsPromise }: { statsPromise: Promise<BoardStats | null> }) {
  const stats = use(statsPromise);
  if (!stats) {
    return null;
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-5 border-white/5 border-b bg-white/1 px-6">
      {/* Streaming badge */}
      <div className="flex items-center gap-1.5 rounded-full border border-purple-500/20 bg-purple-500/8 px-2.5 py-1">
        <span className="h-1.5 w-1.5 rounded-full bg-purple-400" />
        <span className="font-medium text-purple-300 text-xs">Streamed</span>
      </div>

      <span className="h-3 w-px bg-white/8" />

      {/* Per-column counts */}
      {(["backlog", "todo", "doing", "done"] as const).map((col) => (
        <div className="flex items-center gap-1.5" key={col}>
          <span className="text-slate-600 text-xs capitalize">{col}</span>
          <span className={`font-bold text-xs ${COLUMN_COLORS[col]}`}>{stats.byColumn[col]}</span>
        </div>
      ))}

      <span className="h-3 w-px bg-white/8" />

      {/* Completion */}
      <span className="font-medium text-emerald-400 text-xs">{stats.completionRate}% done</span>

      {/* Subtle label */}
      <span className="ml-auto text-slate-700 text-xs">
        via{" "}
        <code className="rounded bg-white/5 px-1 font-mono text-violet-400 text-xs">
          {"<Suspense>"}
        </code>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default route.page({
  loader: ({ params }) => {
    const data = getBoardData(params.boardId);
    if (!data) {
      throw new Response("Board not found", { status: 404 });
    }
    const renderedAt = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return {
      board: data.board,
      initialCards: data.cards as KanbanCard[],
      renderedAt,
    };
  },
  head: ({ board }) => ({
    meta: [{ title: `${board.name} | Task Manager` }],
  }),
  component: ({ board, initialCards, renderedAt, params }) => {
    // refreshKey bumps after each card mutation → new promise → Suspense
    // re-shows the skeleton briefly while the new stats load (~800ms).
    // Using plain setState (not startTransition) because useTransition +
    // use() on an already-resolved Suspense boundary causes isPending to
    // stay true indefinitely.
    const [refreshKey, setRefreshKey] = useState(0);

    // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is an intentional cache-bust trigger
    const statsPromise = useMemo(
      () => fetchBoardStats(params.boardId),
      [params.boardId, refreshKey]
    );

    const onMutation = useCallback(() => {
      setRefreshKey((k) => k + 1);
    }, []);

    return (
      <div className="flex h-screen flex-col">
        {/* Board header */}
        <header className="flex h-14.5 shrink-0 items-center justify-between border-white/5 border-b bg-white/2 px-6 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-linear-to-br from-violet-600 to-indigo-600 font-bold text-sm text-white shadow-md">
              {board.name.charAt(0).toUpperCase()}
            </div>
            <h1 className="font-semibold text-lg text-white">{board.name}</h1>
          </div>

          {/* SSR badge */}
          <div className="flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/8 px-3.5 py-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
            <span className="font-medium text-blue-300 text-xs">
              SSR &middot; rendered at {renderedAt}
            </span>
          </div>
        </header>

        {/* Stats strip — streams on first load via SSR streaming, then
            re-suspends briefly after each card mutation (refreshKey bump). */}
        <Suspense fallback={<StatsBarSkeleton />}>
          <StatsBar statsPromise={statsPromise} />
        </Suspense>

        {/* Kanban board — key forces remount when board changes so useState resets */}
        <div className="flex-1 overflow-hidden">
          <Kanban
            boardId={params.boardId}
            initialCards={initialCards}
            key={params.boardId}
            onMutation={onMutation}
          />
        </div>
      </div>
    );
  },
});
