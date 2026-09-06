// biome-ignore-all lint/performance/noJsxPropsBind: create-board form handlers depend on local input and mutation state
import { useSync } from "@teyik0/furin/client";
import { useRef, useState } from "react";
import { apiClient } from "@/lib/api";

export function CreateBoardForm() {
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const inFlightRef = useRef<boolean>(false);
  const createBoard = useSync(apiClient.api.boards.post);

  const handleCreate = async () => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: concurrent submissions can observe the async lock as true
    if (inFlightRef.current) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    inFlightRef.current = true;
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const { error } = await createBoard({ name: trimmed });
      if (error) {
        throw new Error("Could not create the board. Please try again.");
      }
      setName("");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Could not create the board. Please try again.";
      setErrorMessage(message);
    } finally {
      inFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="mb-10 flex flex-col gap-3">
      {/* react-doctor-disable-next-line react-doctor/no-prevent-default */}
      <form
        className="flex gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          handleCreate();
        }}
      >
        <div className="relative flex-1">
          <input
            aria-label="New board name"
            className="w-full rounded-xl border border-white/8 bg-white/4 px-4 py-3 text-sm text-white outline-none transition-[border-color,background-color,box-shadow] placeholder:text-zinc-600 focus:border-violet-500/40 focus:bg-white/6 focus:ring-1 focus:ring-violet-500/20 disabled:opacity-50"
            disabled={isSubmitting}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name your new board..."
            type="text"
            value={name}
          />
        </div>
        <button
          className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-3 font-semibold text-sm text-white transition-[background-color,box-shadow,transform] hover:bg-violet-500 hover:shadow-lg hover:shadow-violet-500/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isSubmitting}
          type="submit"
        >
          <span>+</span>
          <span>{isSubmitting ? "Creating…" : "Create Board"}</span>
        </button>
      </form>
      {errorMessage ? (
        <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2.5 text-red-300 text-sm">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
