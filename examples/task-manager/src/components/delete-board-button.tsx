import { useState } from "react";
import { api } from "@/lib/api";

export function DeleteBoardButton({ boardId }: { boardId: string }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const deleteBoard = api.boards({ boardId }).delete;

  const handleDelete = async () => {
    if (isDeleting) {
      return;
    }
    setIsDeleting(true);
    try {
      const { error } = await deleteBoard();
      if (error) {
        throw new Error("Could not delete the board. Please try again.");
      }
      setErrorMessage(null);
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not delete the board. Please try again."
      );
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <button
        aria-label={`Delete ${boardId}`}
        className="flex size-6 items-center justify-center rounded-full bg-white/8 text-white/40 text-xs transition-colors hover:bg-red-500/20 hover:text-red-400"
        disabled={isDeleting}
        onClick={handleDelete}
        title="Delete board"
        type="button"
      >
        ×
      </button>
      {errorMessage ? <p className="mt-1 text-red-300 text-xs">{errorMessage}</p> : null}
    </>
  );
}
