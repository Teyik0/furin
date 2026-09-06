// biome-ignore-all lint/performance/noJsxPropsBind: composite component slot renderers are passed as component factories
import { defineRoute } from "@teyik0/furin";
import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";
import type { ComponentType } from "react";
import { getBoards } from "@/api/modules/boards/service";
import { CreateBoardForm } from "@/components/create-board-form";
import { DeleteBoardButton } from "@/components/delete-board-button";
import { route as rootRoute } from "./root";

const AVATAR_COLORS = [
  "from-violet-500 to-indigo-500",
  "from-blue-500 to-cyan-500",
  "from-emerald-500 to-teal-500",
  "from-rose-500 to-pink-500",
  "from-amber-500 to-orange-500",
  "from-fuchsia-500 to-purple-500",
] as const;

function avatarColor(id: string): string {
  return AVATAR_COLORS[id.charCodeAt(0) % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

export const route = defineRoute()
  .config({
    layout: rootRoute,
    mode: "isr",
    revalidate: 10,
    tags: ["boards"],
  })
  .loader(async () => {
    const generatedAt = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const boards = getBoards().map((board) => ({
      ...board,
      formattedCreatedAt: new Date(board.createdAt).toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    }));
    const content = await createCompositeComponent<{
      CreateForm: ComponentType;
      DeleteButton: (boardId: string) => React.ReactNode;
    }>(({ CreateForm, DeleteButton }) => (
      <main className="mx-auto max-w-5xl px-6 py-14">
        <header className="mb-12">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1">
            <span className="font-medium text-cyan-300 text-xs">Furin RSC</span>
          </div>
          <h1 className="font-semibold text-5xl tracking-tight">
            <span className="bg-linear-to-br from-cyan-300 via-sky-400 to-emerald-400 bg-clip-text text-transparent">
              Task Manager RSC
            </span>
          </h1>
          <p className="mt-3 max-w-lg text-base text-zinc-400">
            Server-owned board markup with interactive client islands.
          </p>
          <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-cyan-500/20 bg-cyan-500/8 px-3.5 py-1.5">
            <span className="size-2 rounded-full bg-cyan-400" />
            <span className="font-medium text-cyan-300 text-xs">
              RSC + ISR · generated at {generatedAt}
            </span>
          </div>
        </header>

        <CreateForm />

        {boards.length === 0 ? (
          <div className="rounded-2xl border border-white/10 border-dashed py-20 text-center">
            <p className="text-sm text-zinc-500">No boards yet.</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {boards.map((board) => (
              <article
                className="group relative rounded-2xl border border-white/8 bg-white/3 transition-colors hover:border-cyan-500/30 hover:bg-white/5"
                key={board.id}
              >
                <div className="absolute top-3 right-3 z-10">{DeleteButton(board.id)}</div>
                <a className="block p-5" href={`/board/${board.id}`}>
                  <div className="flex items-start gap-3">
                    <div
                      className={`flex size-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br ${avatarColor(board.id)} font-bold text-sm text-white shadow-md`}
                    >
                      {board.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate font-semibold text-base text-white">{board.name}</h2>
                      <p className="mt-0.5 text-xs text-zinc-600">
                        Created {board.formattedCreatedAt}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <div className="flex gap-1.5">
                      {(["backlog", "todo", "doing", "done"] as const).map((column) => (
                        <span
                          className="rounded-md bg-white/5 px-2 py-0.5 font-medium text-xs text-zinc-600 capitalize"
                          key={column}
                        >
                          {column}
                        </span>
                      ))}
                    </div>
                    <span className="text-xs text-zinc-700">→</span>
                  </div>
                </a>
              </article>
            ))}
          </div>
        )}

        <div className="mt-16 flex items-start gap-3 rounded-xl border border-white/5 bg-white/3 p-4">
          <span className="mt-0.5 text-cyan-400 text-sm">i</span>
          <p className="text-xs text-zinc-500 leading-relaxed">
            This page uses the same ISR data and interactions as the reference route. The board
            markup is encoded as Flight and only the create form and delete buttons are hydrated on
            the client.
          </p>
        </div>
      </main>
    ));

    return { content };
  })
  .head(() => ({ meta: [{ title: "Task Manager RSC — Furin" }] }))
  .page(({ data: { content } }) => (
    <CompositeComponent
      CreateForm={() => <CreateBoardForm />}
      DeleteButton={(boardId) => <DeleteBoardButton boardId={boardId} />}
      src={content}
    />
  ));
