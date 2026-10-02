import { defineRoute, notFound } from "@teyik0/furin";
import { Await, defer } from "@teyik0/furin/client";
import { t } from "elysia";
import { Suspense } from "react";
import { StatsBar, StatsBarSkeleton, StatsBarUnavailable } from "@/components/board-page-content";
import { Kanban } from "@/components/ui/kanban";
import { api } from "@/lib/api";
import { route as parentRoute } from "../_route";

export const route = defineRoute()
  .config({
    layout: parentRoute,
    mode: "ssr",
    params: t.Object({ boardId: t.String() }),
  })
  .loader(async ({ params: { boardId } }) => {
    const { data, error } = await api.boards({ boardId }).get();
    if (error) {
      if (error.status === 404) {
        notFound({ message: error.value.detail });
      }
      throw error;
    }

    const initialStats = (async () => {
      const { data: stats, error: statsError } = await api.boards({ boardId }).stats.get();
      if (statsError) {
        throw statsError;
      }
      return stats;
    })();

    return defer({
      board: data.board,
      initialCards: data.cards,
      initialStats,
      renderedAt: new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    });
  })
  .head(({ board }) => ({
    meta: [{ title: `${board.name} | Task Manager` }],
  }))
  .page(({ board: { name }, initialCards, initialStats, renderedAt, params: { boardId } }) => (
    <div className="flex h-screen flex-col">
      <header className="flex h-14.5 shrink-0 items-center justify-between border-white/5 border-b bg-white/2 px-6 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-linear-to-br from-violet-600 to-purple-600 font-bold text-sm text-white shadow-md">
            {name.charAt(0).toUpperCase()}
          </div>
          <h1 className="font-semibold text-lg text-white">{name}</h1>
        </div>

        <div className="flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/8 px-3.5 py-1.5">
          <span className="size-1.5 rounded-full bg-blue-400" />
          <span className="font-medium text-blue-300 text-xs">
            SSR &middot; rendered at {renderedAt}
          </span>
        </div>
      </header>

      <Suspense fallback={<StatsBarSkeleton />}>
        <Await errorElement={<StatsBarUnavailable />} resolve={initialStats}>
          {(resolvedInitialStats) => <StatsBar cards={initialCards} stats={resolvedInitialStats} />}
        </Await>
      </Suspense>

      <div className="flex-1 overflow-hidden">
        <Kanban boardId={boardId} initialCards={initialCards} key={boardId} />
      </div>
    </div>
  ));
