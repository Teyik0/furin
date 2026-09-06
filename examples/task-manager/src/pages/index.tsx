import { defineRoute } from "@teyik0/furin";
import { BoardCard } from "@/components/board-card";
import { CreateBoardForm } from "@/components/create-board-form";
import { client } from "@/lib/api";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "isr", revalidate: 10, tags: ["boards"] })
  .loader(async () => {
    const result = await client.boards.get();
    if (result.error) {
      throw new Error(`Failed to load boards (${result.error.status})`);
    }
    const generatedAt = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const boards = result.data.map((board) => ({
      ...board,
      formattedCreatedAt: new Date(board.createdAt).toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    }));
    return { boards, generatedAt };
  })
  .head(() => ({
    meta: [{ title: "Task Manager — Furin" }],
  }))
  .page(({ data: { boards, generatedAt } }) => {
    return (
      <div className="mx-auto max-w-5xl px-6 py-14">
        {/* Header */}
        <header className="mb-12">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-1">
            <span className="text-violet-400 text-xs">⚡</span>
            <span className="font-medium text-violet-300 text-xs">Furin Framework</span>
          </div>

          <h1 className="font-semibold text-5xl tracking-tight">
            <span className="bg-linear-to-br from-violet-400 via-purple-400 to-sky-400 bg-clip-text text-transparent">
              Task Manager
            </span>
          </h1>

          <p className="mt-3 max-w-lg text-base text-zinc-400">
            A Trello-inspired board powered by Furin: featuring ISR, SSR, nested layouts and
            drag-and-drop kanban.
          </p>

          {/* ISR badge */}
          <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/8 px-3.5 py-1.5">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            <span className="font-medium text-emerald-400 text-xs">
              ISR &middot; revalidates every 10s &middot; generated at {generatedAt}
            </span>
          </div>
        </header>

        {/* Create board form */}
        <CreateBoardForm />

        {/* Boards grid */}
        {boards.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 border-dashed py-20 text-center">
            <div className="mb-3 text-4xl opacity-30">📋</div>
            <p className="text-sm text-zinc-500">No boards yet.</p>
            <p className="mt-1 text-xs text-zinc-600">Create one above to get started.</p>
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
          <p className="text-xs text-zinc-500 leading-relaxed">
            This page uses{" "}
            <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">
              mode: "isr"
            </code>{" "}
            with{" "}
            <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">
              revalidate: 10
            </code>
            . The board list is served from cache and revalidates in the background every 10
            seconds. After creating or deleting a board, the API route declares{" "}
            <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">
              sync: {'{ invalidate: { tags: ["boards"] } }'}
            </code>{" "}
            to immediately bust the cache and broadcast the update over SSE.
          </p>
        </div>
      </div>
    );
  });
