import { Link } from "@teyik0/furin/link";
import type { Board } from "@/api/modules/boards/service";
import { getBoards } from "@/api/modules/boards/service";
import { apiClient } from "@/lib/api";
import { route } from "./root";

const AVATAR_COLORS = [
  "from-violet-500 to-indigo-500",
  "from-blue-500 to-cyan-500",
  "from-emerald-500 to-teal-500",
  "from-rose-500 to-pink-500",
  "from-amber-500 to-orange-500",
  "from-fuchsia-500 to-purple-500",
];

function avatarColor(id: string): string {
  const idx = id.charCodeAt(0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[idx] ?? (AVATAR_COLORS[0] as string);
}

export default route.page({
  mode: "isr",
  revalidate: 10,
  loader: () => {
    const boards = getBoards();
    const generatedAt = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return { boards, generatedAt };
  },
  head: () => ({
    meta: [{ title: "Task Manager — Furin" }],
  }),
  component: ({ boards, generatedAt }) => {
    return (
      <div className="mx-auto max-w-5xl px-6 py-14">
        {/* Header */}
        <header className="mb-12">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-1">
            <span className="text-violet-400 text-xs">⚡</span>
            <span className="font-medium text-violet-300 text-xs">Furin Framework</span>
          </div>

          <h1 className="font-bold text-5xl tracking-tight">
            <span className="bg-linear-to-br from-violet-400 via-indigo-400 to-sky-400 bg-clip-text text-transparent">
              Task Manager
            </span>
          </h1>

          <p className="mt-3 max-w-lg text-base text-slate-400">
            A Trello-inspired board powered by Furin — featuring ISR, SSR, nested layouts and
            drag-and-drop kanban.
          </p>

          {/* ISR badge */}
          <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/8 px-3.5 py-1.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            <span className="font-medium text-emerald-400 text-xs">
              ISR &middot; revalidates every 10s &middot; generated at {generatedAt}
            </span>
          </div>
        </header>

        {/* Create board form */}
        <form action="/api/boards" className="mb-10 flex gap-3" method="post">
          <div className="relative flex-1">
            <input
              className="w-full rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-violet-500/40 focus:bg-white/6 focus:ring-1 focus:ring-violet-500/20"
              name="name"
              placeholder="Name your new board..."
              required
              type="text"
            />
          </div>
          <button
            className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-3 font-semibold text-sm text-white transition-all hover:bg-violet-500 hover:shadow-lg hover:shadow-violet-500/20 active:scale-[0.98]"
            type="submit"
          >
            <span>+</span>
            <span>Create Board</span>
          </button>
        </form>

        {/* Boards grid */}
        {boards.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 border-dashed py-20 text-center">
            <div className="mb-3 text-4xl opacity-30">📋</div>
            <p className="text-slate-500 text-sm">No boards yet.</p>
            <p className="mt-1 text-slate-600 text-xs">Create one above to get started.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((board) => (
              <BoardCard board={board} key={board.id} />
            ))}
          </div>
        )}

        {/* Footer info */}
        <div className="mt-16 flex items-start gap-3 rounded-xl border border-white/5 bg-white/3 p-4">
          <span className="mt-0.5 text-sm text-violet-400">ℹ</span>
          <p className="text-slate-500 text-xs leading-relaxed">
            This page uses{" "}
            <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">
              mode: "isr"
            </code>{" "}
            with{" "}
            <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">
              revalidate: 10
            </code>
            . The board list is served from cache and revalidates in the background every 10
            seconds. After creating or deleting a board,{" "}
            <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">
              revalidatePath("/")
            </code>{" "}
            is called server-side to immediately bust the cache.
          </p>
        </div>
      </div>
    );
  },
});

function BoardCard({ board }: { board: Board }) {
  const gradient = avatarColor(board.id);
  const initial = board.name.charAt(0).toUpperCase();

  return (
    <div className="group relative rounded-2xl border border-white/8 bg-white/3 transition-all duration-200 hover:border-violet-500/30 hover:bg-white/5 hover:shadow-violet-500/5 hover:shadow-xl">
      {/* Delete button */}
      <form
        action={`/api/boards/${board.id}`}
        className="absolute top-3 right-3 z-10 opacity-0 transition-opacity group-hover:opacity-100"
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          apiClient.api
            .boards({ boardId: board.id })
            .delete()
            .then(() => {
              window.location.reload();
            });
        }}
      >
        <button
          className="flex h-6 w-6 items-center justify-center rounded-full bg-white/8 text-slate-500 text-xs transition-colors hover:bg-red-500/20 hover:text-red-400"
          title="Delete board"
          type="submit"
        >
          ×
        </button>
      </form>

      <Link className="block p-5" to={`/board/${board.id}`}>
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br ${gradient} font-bold text-sm text-white shadow-md`}
          >
            {initial}
          </div>

          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold text-base text-white transition-colors group-hover:text-violet-200">
              {board.name}
            </h2>
            <p className="mt-0.5 text-slate-600 text-xs">
              Created{" "}
              {new Date(board.createdAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1.5">
            {(["backlog", "todo", "doing", "done"] as const).map((col) => (
              <span
                className="rounded-md bg-white/5 px-2 py-0.5 font-medium text-slate-600 text-xs capitalize"
                key={col}
              >
                {col}
              </span>
            ))}
          </div>
          <span className="text-slate-700 text-xs">→</span>
        </div>
      </Link>
    </div>
  );
}
