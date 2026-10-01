import { defineRoute, notFound } from "@teyik0/furin";
import { Link, useRouter } from "@teyik0/furin/link";
import { t } from "elysia";
import { useState } from "react";
import { FaArrowLeft, FaChevronRight } from "react-icons/fa";
import { FiTrash2 } from "react-icons/fi";
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
  .page(({ card, boardName, renderedAt, formattedCreatedAt, params }) => {
    const [seededCard, setSeededCard] = useState(card);
    const [isDirty, setIsDirty] = useState(false);
    const [title, setTitle] = useState(card.title);
    const [description, setDescription] = useState(card.description);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    if (
      seededCard.id !== card.id ||
      seededCard.title !== card.title ||
      seededCard.description !== card.description
    ) {
      setSeededCard(card);
      if (seededCard.id !== card.id || !isDirty) {
        setIsDirty(false);
        setTitle(card.title);
        setDescription(card.description);
        setErrorMessage(null);
      }
    }
    const router = useRouter();

    const handleSave = async (formData: FormData) => {
      const changes = {
        description: String(formData.get("description") ?? ""),
        title: String(formData.get("title") ?? ""),
      };
      const { error } = await api.cards({ id: card.id }).patch(changes, {
        optimistic(cache) {
          cache.update(api.cards({ id: card.id }).get, (data) => ({ ...data, ...changes }));
          cache.update(api.boards({ boardId: params.boardId }).get, (data) => ({
            ...data,
            cards: data.cards.map((item) => (item.id === card.id ? { ...item, ...changes } : item)),
          }));
        },
      });

      if (error) {
        setErrorMessage(error.value.detail ?? "Validation error");
        return;
      }
      setErrorMessage(null);
      await router.navigate(`/board/${params.boardId}`);
    };

    const handleDelete = async () => {
      const { error } = await api.cards({ id: card.id }).delete(undefined, {
        optimistic: (cache) =>
          cache.update(api.boards({ boardId: params.boardId }).get, (data) => ({
            ...data,
            cards: data.cards.filter((item) => item.id !== card.id),
          })),
      });
      if (error) {
        setErrorMessage(error.value.detail);
        return;
      }
      setErrorMessage(null);
      await router.navigate(`/board/${params.boardId}`);
    };

    return (
      <div className="flex min-h-screen flex-col">
        <header className="flex shrink-0 items-center justify-between border-white/5 border-b bg-white/2 px-6 py-3.5 backdrop-blur-sm">
          <nav className="flex items-center gap-1.5 text-sm">
            <Link
              className="flex items-center gap-1.5 text-zinc-500 transition-colors hover:text-zinc-300"
              to={`/board/${params.boardId}`}
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
              {errorMessage ? (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-red-300 text-sm">
                  {errorMessage}
                </div>
              ) : null}

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
                    setIsDirty(true);
                    setTitle(event.target.value);
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
                    setIsDirty(true);
                    setDescription(event.target.value);
                  }}
                  placeholder="Add a description..."
                  rows={5}
                  value={description}
                />
              </div>

              <div className="flex items-center justify-between pt-1">
                <button
                  className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-2.5 font-medium text-red-400 text-sm transition-[border-color,background-color,transform] hover:border-red-500/40 hover:bg-red-500/15 active:scale-[0.98]"
                  onClick={handleDelete}
                  type="button"
                >
                  <FiTrash2 size={14} />
                  Delete card
                </button>

                <button
                  className="rounded-xl bg-violet-600 px-5 py-2.5 font-semibold text-sm text-white shadow-lg shadow-violet-500/20 transition-[background-color,transform] hover:bg-violet-500 active:scale-[0.98]"
                  type="submit"
                >
                  Save Changes
                </button>
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
