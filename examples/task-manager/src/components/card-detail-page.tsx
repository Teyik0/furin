// biome-ignore-all lint/performance/noJsxPropsBind: card form handlers depend on local form and mutation state
import { useSync } from "@teyik0/furin/client";
import { Link, useRouter } from "@teyik0/furin/link";
import { ArrowLeft, ChevronRight, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { apiClient } from "@/lib/api";

export function CardDetailPage({
  params,
  card,
  boardName,
  renderedAt,
  formattedCreatedAt,
}: {
  params: { boardId: string; cardId: string };
  card: { id: string; title: string; description: string; createdAt: string; boardId: string };
  boardName: string;
  renderedAt: string;
  formattedCreatedAt: string;
}) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const updateCard = useSync(apiClient.api.cards({ id: card.id }).patch);
  const deleteCard = useSync(apiClient.api.cards({ id: card.id }).delete);

  const handleSave = async () => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the ref is null before the form mounts
    if (!formRef.current) {
      return;
    }
    const data = new FormData(formRef.current);
    try {
      const { error } = await updateCard({
        description: data.get("description") as string,
        title: data.get("title") as string,
      });

      if (error) {
        throw new Error("Could not save the card. Please try again.");
      }

      setErrorMessage(null);
      await router.navigate(`/board/${params.boardId}`);
    } catch (err: unknown) {
      const error =
        err instanceof Error ? err.message : "Could not save the card. Please try again.";
      setErrorMessage(error);
    }
  };

  const handleDelete = async () => {
    try {
      const { error } = await deleteCard();
      if (error) {
        throw new Error("Could not delete the card. Please try again.");
      }

      setErrorMessage(null);
      await router.navigate(`/board/${params.boardId}`);
    } catch (err: unknown) {
      const error =
        err instanceof Error ? err.message : "Could not delete the card. Please try again.";
      setErrorMessage(error);
    }
  };

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar */}
      <header className="flex shrink-0 items-center justify-between border-white/5 border-b bg-white/2 px-6 py-3.5 backdrop-blur-sm">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1.5 text-sm">
          <Link
            className="flex items-center gap-1.5 text-zinc-500 transition-colors hover:text-zinc-300"
            to={`/board/${params.boardId}`}
          >
            <ArrowLeft size={13} />
            <span>{boardName}</span>
          </Link>
          <ChevronRight className="text-zinc-700" size={12} />
          <span className="max-w-xs truncate font-medium text-zinc-300">{card.title}</span>
        </nav>

        {/* SSR badge */}
        <div className="flex items-center gap-2 rounded-full border border-blue-500/20 bg-blue-500/8 px-3 py-1">
          <span className="size-1.5 rounded-full bg-blue-400" />
          <span className="font-medium text-blue-300 text-xs">SSR &middot; {renderedAt}</span>
        </div>
      </header>

      {/* Content */}
      <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
        {/* Card panel */}
        <div className="rounded-2xl border border-white/8 bg-white/3 shadow-2xl shadow-black/20 backdrop-blur-sm">
          {/* Panel header */}
          <div className="border-white/5 border-b px-6 py-5">
            <p className="mb-1 font-semibold text-xs text-zinc-600 uppercase tracking-wider">
              Card
            </p>
            <h1 className="font-semibold text-white text-xl">{card.title}</h1>
            <p className="mt-1 text-xs text-zinc-600">Created {formattedCreatedAt}</p>
          </div>

          {/* Form */}
          {/* react-doctor-disable-next-line react-doctor/no-prevent-default */}
          <form
            className="space-y-5 p-6"
            onSubmit={(e) => {
              e.preventDefault();
              handleSave();
            }}
            ref={formRef}
          >
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
                defaultValue={card.title}
                id="card-title"
                name="title"
                placeholder="Card title..."
                type="text"
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
                defaultValue={card.description}
                id="card-description"
                name="description"
                placeholder="Add a description..."
                rows={5}
              />
            </div>

            <div className="flex items-center justify-between pt-1">
              <button
                className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-2.5 font-medium text-red-400 text-sm transition-[border-color,background-color,transform] hover:border-red-500/40 hover:bg-red-500/15 active:scale-[0.98]"
                onClick={handleDelete}
                type="button"
              >
                <Trash2 size={14} />
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

        {/* Route info box */}
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
            <code className="rounded bg-white/6 px-1 py-0.5 font-mono text-violet-300">cardId</code>{" "}
            are typed via Elysia validators and flow through the entire chain.
          </p>
        </div>
      </div>
    </div>
  );
}
