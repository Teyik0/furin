import { defineRoute, notFound } from "@teyik0/furin";
import { useMutation } from "@teyik0/furin/client";
import { Link, useRouter } from "@teyik0/furin/link";
import { t } from "elysia";
import { useState } from "react";
import { FaArrowLeft, FaChevronRight } from "react-icons/fa";
import { FiTrash2 } from "react-icons/fi";
import type { Card } from "@/db/schema";
import { api } from "@/lib/api";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({
    layout: parentRoute,
    mode: "ssr",
    params: t.Object({ boardId: t.String(), cardId: t.String() }),
  })
  .loader(async ({ params }) => {
    const [{ data: boardData, error: boardError }, { data: card, error: cardError }] =
      await Promise.all([
        api.boards({ boardId: params.boardId }).get(),
        api.cards({ id: params.cardId }).get(),
      ]);

    if (boardError) {
      if (boardError.status === 404) {
        notFound({ message: boardError.value.detail });
      }
      throw boardError;
    }
    if (cardError) {
      if (cardError.status === 404) {
        notFound({ message: cardError.value.detail });
      }
      throw cardError;
    }
    if (card.boardId !== params.boardId) {
      notFound({ message: "Card not found" });
    }

    const renderedAt = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const formattedCreatedAt = new Date(card.createdAt).toLocaleDateString("en-US", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    return {
      boardName: boardData.board.name,
      card,
      formattedCreatedAt,
      renderedAt,
    };
  })
  .head(({ card, boardName }) => ({
    meta: [{ title: `${card.title} | ${boardName} | Task Manager` }],
  }))
  .page(({ card, boardName, renderedAt, formattedCreatedAt, params: { boardId } }) => {
    const [draft, setDraft] = useState<Pick<Card, "title" | "description"> | null>(null);
    const { title, description } = draft ?? card;
    const router = useRouter();
    const save = useMutation(api.cards({ id: card.id }).patch, {
      onSuccess: () => router.navigate(`/board/${boardId}`),
    });
    const remove = useMutation(api.cards({ id: card.id }).delete, {
      onSuccess: () => router.navigate(`/board/${boardId}`),
    });
    const isMutating = save.isPending || remove.isPending;

    const handleSave = (formData: FormData) => {
      const changes = {
        description: String(formData.get("description") ?? ""),
        title: String(formData.get("title") ?? ""),
      };
      save.mutate(changes, {
        optimistic(cache) {
          cache.update(api.cards({ id: card.id }).get, (data) => ({ ...data, ...changes }));
          cache.update(api.boards({ boardId }).get, (data) => ({
            ...data,
            cards: data.cards.map((item) => (item.id === card.id ? { ...item, ...changes } : item)),
          }));
        },
      });
    };
    const handleDelete = () => {
      remove.mutate(undefined, {
        optimistic: (cache) =>
          cache.update(api.boards({ boardId }).get, (data) => ({
            ...data,
            cards: data.cards.filter((item) => item.id !== card.id),
          })),
      });
    };

    return (
      <div className="flex min-h-screen flex-col">
        <header className="flex shrink-0 items-center justify-between border-white/5 border-b bg-white/2 px-6 py-3.5 backdrop-blur-sm">
          <nav className="flex items-center gap-1.5 text-sm">
            <Link
              className="flex items-center gap-1.5 text-zinc-500 transition-colors hover:text-zinc-300"
              to={`/board/${boardId}`}
            >
              <FaArrowLeft size={13} />
              <span>{boardName}</span>
            </Link>
            <FaChevronRight className="text-zinc-700" size={12} />
            <span className="max-w-xs truncate font-medium text-zinc-300">{card.title}</span>
          </nav>

          <div className="flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/8 px-3 py-1">
            <span className="size-1.5 rounded-full bg-blue-400" />
            <span className="font-medium text-blue-300 text-xs">SSR &middot; {renderedAt}</span>
          </div>
        </header>

        <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
          <div className="rounded-2xl border border-white/8 bg-white/3 shadow-2xl shadow-black/20 backdrop-blur-sm">
            <div className="border-white/5 border-b px-6 py-5">
              <p className="mb-1 font-semibold text-xs text-zinc-600 uppercase tracking-wider">
                Card
              </p>
              <h1 className="font-semibold text-white text-xl">{card.title}</h1>
              <p className="mt-1 text-xs text-zinc-600">Created {formattedCreatedAt}</p>
            </div>

            <form action={handleSave} className="space-y-5 p-6">
              <div>
                <label
                  className="mb-1.5 block font-semibold text-xs text-zinc-500 uppercase tracking-wider"
                  htmlFor="card-title"
                >
                  Title
                </label>
                <input
                  aria-label="Card title"
                  className="w-full rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-white outline-none transition-[border-color,background-color,box-shadow] placeholder:text-zinc-600 focus:border-violet-500/50 focus:bg-white/6 focus:ring-1 focus:ring-violet-500/20"
                  id="card-title"
                  name="title"
                  onChange={(event) => {
                    const { value } = event.target;
                    setDraft((current) => ({ ...(current ?? card), title: value }));
                  }}
                  placeholder="Card title..."
                  type="text"
                  value={title}
                />
              </div>

              <div>
                <label
                  className="mb-1.5 block font-semibold text-xs text-zinc-500 uppercase tracking-wider"
                  htmlFor="card-description"
                >
                  Description
                </label>
                <textarea
                  aria-label="Card description"
                  className="w-full resize-none rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-white outline-none transition-[border-color,background-color,box-shadow] placeholder:text-zinc-600 focus:border-violet-500/50 focus:bg-white/6 focus:ring-1 focus:ring-violet-500/20"
                  id="card-description"
                  name="description"
                  onChange={(event) => {
                    const { value } = event.target;
                    setDraft((current) => ({ ...(current ?? card), description: value }));
                  }}
                  placeholder="Add a description..."
                  rows={5}
                  value={description}
                />
              </div>

              <div className="flex items-start justify-between gap-4 pt-1">
                <div className="space-y-2">
                  <button
                    aria-describedby={remove.error ? "card-delete-error" : undefined}
                    className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-2.5 font-medium text-red-400 text-sm transition-[border-color,background-color,transform] hover:border-red-500/40 hover:bg-red-500/15 active:scale-[0.98]"
                    disabled={isMutating}
                    onClick={handleDelete}
                    type="button"
                  >
                    <FiTrash2 size={14} />
                    Delete card
                  </button>
                  {remove.error ? (
                    <p
                      className="max-w-xs text-red-300 text-sm"
                      id="card-delete-error"
                      role="alert"
                    >
                      {remove.error.value.detail}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2 text-right">
                  <button
                    aria-describedby={save.error ? "card-save-error" : undefined}
                    className="rounded-xl bg-violet-600 px-5 py-2.5 font-semibold text-sm text-white shadow-lg shadow-violet-500/20 transition-[background-color,transform] hover:bg-violet-500 active:scale-[0.98]"
                    disabled={isMutating}
                    type="submit"
                  >
                    Save Changes
                  </button>
                  {save.error ? (
                    <p className="max-w-xs text-red-300 text-sm" id="card-save-error" role="alert">
                      {save.error.value.detail}
                    </p>
                  ) : null}
                </div>
              </div>
            </form>
          </div>

          <div className="mt-6 flex items-start gap-3 rounded-xl border border-white/5 bg-white/2 px-4 py-3.5">
            <span className="mt-0.5 text-violet-400 text-xs">ℹ</span>
            <p className="text-xs text-zinc-600 leading-relaxed">
              This page uses{" "}
              <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">SSR</code>{" "}
              with a nested route chain:{" "}
              <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-zinc-400">root</code> →{" "}
              <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-zinc-400">
                board sidebar
              </code>{" "}
              →{" "}
              <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-zinc-400">
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
  });
