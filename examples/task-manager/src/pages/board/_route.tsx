import { defineRoute } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { t } from "elysia";
import type { Board } from "@/db/schema";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { route as rootRoute } from "../root";

const PALETTE = [
  "#a78bfa", // violet
  "#67e8f9", // cyan
  "#6ee7b7", // emerald
  "#fca5a5", // rose
  "#fcd34d", // amber
  "#93c5fd", // blue
];

function boardHue(id: string): string {
  return PALETTE[id.charCodeAt(0) % PALETTE.length] ?? (PALETTE[0] as string);
}

export const route = defineRoute()
  .config({
    layout: rootRoute,
    mode: "ssr",
    params: t.Object({ boardId: t.String() }),
  })
  .loader(async () => {
    const { data: sidebarBoards, error } = await api.boards.get();
    if (error) {
      throw error;
    }
    return { sidebarBoards };
  })
  .layout(({ sidebarBoards, children }) => (
    <div className="flex min-h-screen">
      <aside className="flex w-55 shrink-0 flex-col border-white/5 border-r bg-[#0a0a0c]">
        <div className="flex h-14.5 items-center border-white/5 border-b px-4">
          <Link className="flex items-center gap-3" to="/">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-linear-to-br from-violet-700 to-purple-700 shadow-[0_0_14px_rgba(124,58,237,0.45)]">
              <span className="text-sm">⚡</span>
            </div>
            <div>
              <p className="font-semibold text-[13px] text-white leading-[1.2]">Task Manager</p>
              <p className="mt-0.5 text-[10px] text-white/22">by Furin</p>
            </div>
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <p className="mb-1.5 px-2.5 font-bold text-[9px] text-white/18 uppercase tracking-widest">
            Boards
          </p>

          {sidebarBoards.map((board: Board) => (
            <Link
              activeProps={({ isActive }) => ({
                className: cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors hover:bg-white/5 hover:text-white/75",
                  isActive ? "bg-white/[0.07] text-white" : "text-white/[0.42]"
                ),
              })}
              key={board.id}
              to={`/board/${board.id}`}
            >
              <span
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-md font-bold text-[9px]"
                style={{
                  background: `${boardHue(board.id)}18`,
                  border: `1px solid ${boardHue(board.id)}35`,
                  color: boardHue(board.id),
                }}
              >
                {board.name.charAt(0).toUpperCase()}
              </span>
              <span className="truncate leading-none">{board.name}</span>
            </Link>
          ))}
        </nav>

        <div className="border-white/5 border-t p-3">
          <Link
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/3 px-3 py-2 font-medium text-white/38 text-xs no-underline transition-colors duration-150"
            to="/"
          >
            <span>＋</span>
            <span>New Board</span>
          </Link>

          <div className="mt-2 flex items-center justify-center gap-1.5 rounded-md bg-emerald-400/5 p-1.5">
            <span className="size-1.25 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
            <span className="font-medium text-[10px] text-emerald-400/50 tracking-[0.04em]">
              SSR Layout
            </span>
          </div>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  ));
