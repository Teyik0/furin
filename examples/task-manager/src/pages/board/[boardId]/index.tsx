import { getBoardData } from "@/api/modules/boards/service";
import { Kanban, type KanbanCard } from "../../../components/ui/kanban";
import { route } from "../_route";

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

        {/* Kanban board — key forces remount when board changes so useState resets */}
        <div className="flex-1 overflow-hidden">
          <Kanban boardId={params.boardId} initialCards={initialCards} key={params.boardId} />
        </div>
      </div>
    );
  },
});
