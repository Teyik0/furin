import { Link, useRouter } from "@teyik0/furin/link";
import { ArrowLeft, ChevronRight, Trash2 } from "lucide-react";
import { getBoard } from "@/api/modules/boards/service";
import { getCard } from "@/api/modules/cards/service";
import { apiClient } from "@/lib/api";
import { route } from "./_route";

export default route.page({
  loader: ({ params }) => {
    const board = getBoard(params.boardId);
    const card = getCard(params.cardId);

    if (!board) {
      throw new Response("Board not found", { status: 404 });
    }
    if (!card) {
      throw new Response("Card not found", { status: 404 });
    }
    if (card.boardId !== params.boardId) {
      throw new Response("Card not found", { status: 404 });
    }

    const renderedAt = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    return {
      boardName: board.name,
      card,
      renderedAt,
    };
  },
  head: ({ card, boardName }) => ({
    meta: [{ title: `${card.title} | ${boardName} | Task Manager` }],
  }),
  component: ({ params, card, boardName, renderedAt }) => {
    const router = useRouter();

    return (
      <div className="flex min-h-screen flex-col">
        {/* Top bar */}
        <header className="flex shrink-0 items-center justify-between border-white/5 border-b bg-white/2 px-6 py-3.5 backdrop-blur-sm">
          {/* Breadcrumb */}
          <nav className="flex items-center gap-1.5 text-sm">
            <Link
              className="flex items-center gap-1.5 text-slate-500 transition-colors hover:text-slate-300"
              to={`/board/${params.boardId}`}
            >
              <ArrowLeft size={13} />
              <span>{boardName}</span>
            </Link>
            <ChevronRight className="text-slate-700" size={12} />
            <span className="max-w-xs truncate font-medium text-slate-300">{card.title}</span>
          </nav>

          {/* SSR badge */}
          <div className="flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/8 px-3 py-1">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
            <span className="font-medium text-blue-300 text-xs">SSR &middot; {renderedAt}</span>
          </div>
        </header>

        {/* Content */}
        <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
          {/* Card panel */}
          <div className="rounded-2xl border border-white/8 bg-white/3 shadow-2xl shadow-black/20 backdrop-blur-sm">
            {/* Panel header */}
            <div className="border-white/5 border-b px-6 py-5">
              <p className="mb-1 font-semibold text-slate-600 text-xs uppercase tracking-wider">
                Card
              </p>
              <h1 className="font-bold text-white text-xl">{card.title}</h1>
              <p className="mt-1 text-slate-600 text-xs">
                Created{" "}
                {new Date(card.createdAt).toLocaleDateString("en-US", {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </p>
            </div>

            {/* Form */}
            <form
              className="space-y-5 px-6 py-6"
              onSubmit={async (e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                await apiClient.api.cards({ id: card.id }).patch({
                  title: data.get("title") as string,
                  description: data.get("description") as string,
                });
                await router.navigate(`/board/${params.boardId}`);
              }}
            >
              <div>
                <label
                  className="mb-1.5 block font-semibold text-slate-500 text-xs uppercase tracking-wider"
                  htmlFor="card-title"
                >
                  Title
                </label>
                <input
                  className="w-full rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-violet-500/50 focus:bg-white/6 focus:ring-1 focus:ring-violet-500/20"
                  defaultValue={card.title}
                  id="card-title"
                  name="title"
                  placeholder="Card title..."
                  type="text"
                />
              </div>

              <div>
                <label
                  className="mb-1.5 block font-semibold text-slate-500 text-xs uppercase tracking-wider"
                  htmlFor="card-description"
                >
                  Description
                </label>
                <textarea
                  className="w-full resize-none rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-violet-500/50 focus:bg-white/6 focus:ring-1 focus:ring-violet-500/20"
                  defaultValue={card.description}
                  id="card-description"
                  name="description"
                  placeholder="Add a description..."
                  rows={5}
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-2.5 font-medium text-red-400 text-sm transition-all hover:border-red-500/40 hover:bg-red-500/15 active:scale-[0.98]"
                  onClick={async () => {
                    await apiClient.api.cards({ id: card.id }).delete();
                    await router.navigate(`/board/${params.boardId}`);
                  }}
                  type="button"
                >
                  <Trash2 size={14} />
                  Delete card
                </button>

                <button
                  className="rounded-xl bg-violet-600 px-5 py-2.5 font-semibold text-sm text-white shadow-lg shadow-violet-500/20 transition-all hover:bg-violet-500 active:scale-[0.98]"
                  type="submit"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>

          {/* Route info box */}
          <div className="mt-6 flex items-start gap-3 rounded-xl border border-white/5 bg-white/2 px-4 py-3.5">
            <span className="mt-0.5 text-violet-400 text-xs">ℹ</span>
            <p className="text-slate-600 text-xs leading-relaxed">
              This page uses{" "}
              <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">SSR</code>{" "}
              with a nested route chain:{" "}
              <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-slate-400">root</code>{" "}
              →{" "}
              <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-slate-400">
                board sidebar
              </code>{" "}
              →{" "}
              <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-slate-400">
                card detail
              </code>
              . Params{" "}
              <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">
                boardId
              </code>{" "}
              and{" "}
              <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">
                cardId
              </code>{" "}
              are typed via Elysia validators and flow through the entire chain.
            </p>
          </div>
        </div>
      </div>
    );
  },
});
