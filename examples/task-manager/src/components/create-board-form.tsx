import { useMutation } from "@teyik0/furin/client";
import { useState } from "react";
import { api } from "@/lib/api";

export function CreateBoardForm() {
  const [name, setName] = useState("");
  const create = useMutation(api.boards.post);

  const handleCreate = (formData: FormData) => {
    const trimmed = String(formData.get("name") ?? "").trim();
    create.mutate(
      { name: trimmed },
      {
        optimistic: (cache) => {
          cache.update(api.boards.get, (data) => [
            {
              id: crypto.randomUUID(),
              name,
              createdAt: new Date().toISOString(),
            },
            ...data,
          ]);
        },
      }
    );
  };

  return (
    <div className="mb-10 flex flex-col gap-3">
      <form action={handleCreate} className="flex gap-3">
        <div className="relative flex-1">
          <input
            aria-label="New board name"
            className="w-full rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-white outline-none transition-[border-color,background-color,box-shadow] placeholder:text-zinc-600 focus:border-violet-500/40 focus:bg-white/6 focus:ring-1 focus:ring-violet-500/20 disabled:opacity-50"
            disabled={create.isPending}
            name="name"
            onChange={(e) => setName(e.target.value)}
            placeholder="Name your new board..."
            type="text"
            value={name}
          />
        </div>
        <button
          className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-3 font-semibold text-sm text-white transition-[background-color,box-shadow,transform] hover:bg-violet-500 hover:shadow-lg hover:shadow-violet-500/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          disabled={create.isPending}
          type="submit"
        >
          <span>+</span>
          <span>{create.isPending ? "Creating…" : "Create Board"}</span>
        </button>
      </form>
      {!create.isPending && create.error ? (
        <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-red-300 text-sm">
          {create.error.value.detail}
        </p>
      ) : null}
    </div>
  );
}
