// biome-ignore-all lint/performance/noJsxPropsBind: board card actions depend on per-board mutation state
import { useSync } from "@teyik0/furin/client";
import { Link } from "@teyik0/furin/link";
import { useState } from "react";
import type { Board } from "@/api/modules/boards/service";
import { apiClient } from "@/lib/api";

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

export function BoardCard({ board }: { board: Board & { formattedCreatedAt: string } }) {
  const gradient = avatarColor(board.id);
  const initial = board.name.charAt(0).toUpperCase();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const deleteBoard = useSync(apiClient.api.boards({ boardId: board.id }).delete);

  const handleDelete = async () => {
    try {
      const { error } = await deleteBoard();
      if (error) {
        throw new Error("Could not delete the board. Please try again.");
      }
      setErrorMessage(null);
    } catch (err: unknown) {
      const error =
        err instanceof Error ? err.message : "Could not delete the board. Please try again.";
      setErrorMessage(error);
    }
  };

  return (
    <div className="group relative rounded-2xl border border-white/8 bg-white/3 transition-[border-color,background-color,box-shadow] duration-200 hover:border-violet-500/30 hover:bg-white/5 hover:shadow-violet-500/5 hover:shadow-xl">
      {/* Delete button */}
      <div className="absolute top-3 right-3 z-10 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          className="flex size-6 items-center justify-center rounded-full bg-white/8 text-white/40 text-xs transition-colors hover:bg-red-500/20 hover:text-red-400"
          onClick={handleDelete}
          title="Delete board"
          type="button"
        >
          ×
        </button>
      </div>

      <Link className="block p-5" to={`/board/${board.id}`}>
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div
            className={`flex size-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br ${gradient} font-bold text-sm text-white shadow-md`}
          >
            {initial}
          </div>

          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold text-base text-white transition-colors group-hover:text-violet-200">
              {board.name}
            </h2>
            {errorMessage ? <p className="mt-1 text-red-300 text-xs">{errorMessage}</p> : null}
            <p className="mt-0.5 text-xs text-zinc-600">Created {board.formattedCreatedAt}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1.5">
            {(["backlog", "todo", "doing", "done"] as const).map((col) => (
              <span
                className="rounded-md bg-white/5 px-2 py-0.5 font-medium text-xs text-zinc-600 capitalize"
                key={col}
              >
                {col}
              </span>
            ))}
          </div>
          <span className="text-xs text-zinc-700">→</span>
        </div>
      </Link>
    </div>
  );
}
