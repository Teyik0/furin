import { defineRoute, notFound } from "@teyik0/furin";
import { defer } from "@teyik0/furin/client";
import { t } from "elysia";
import { getBoardData, getBoardStatsDeferred } from "@/api/modules/boards/service";
import { BoardPageContent } from "@/components/board-page-content";
import type { KanbanCard } from "@/components/ui/kanban";
import { route as parentRoute } from "../_route";

export const route = defineRoute()
  .config({
    layout: parentRoute,
    mode: "ssr",
    params: t.Object({ boardId: t.String() }),
    tags: ["board", "cards"],
  })
  .loader(({ params }) => {
    const data = getBoardData(params.boardId);
    if (!data) {
      notFound({ message: "Board not found" });
    }

    return defer({
      board: data.board,
      initialCards: data.cards as KanbanCard[],
      initialStats: getBoardStatsDeferred(params.boardId),
      renderedAt: new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    });
  })
  .head(({ data: { board } }) => ({
    meta: [{ title: `${board.name} | Task Manager` }],
  }))
  .page(({ data: { board, initialCards, initialStats, renderedAt }, params }) => (
    <BoardPageContent
      boardId={params.boardId}
      boardName={board.name}
      initialCards={initialCards}
      initialStats={initialStats}
      key={params.boardId}
      renderedAt={renderedAt}
    />
  ));
