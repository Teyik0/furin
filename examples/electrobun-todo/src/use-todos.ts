import { useMutation } from "@teyik0/furin/client";
import { useState } from "react";
import type { Todo, TodoFilter } from "./todo-types";
import { useTodoTransport } from "./ui/todo-transport";

export function useTodos(initialTodos: Todo[]) {
  const { api, refresh, status, error: syncError } = useTodoTransport();
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState<TodoFilter>("all");
  const [edit, setEdit] = useState<{ id: string | undefined; draft: string }>({
    id: undefined,
    draft: "",
  });
  // A committed write is successful even if the subsequent snapshot refresh fails.
  const nudge = () => {
    refresh().catch(() => undefined);
  };
  const create = useMutation(api.todos.post);
  const patch = useMutation(
    (id: string, body: { title?: string; completed?: boolean }) => api.todos({ id }).patch(body),
    { onSuccess: nudge }
  );
  const remove = useMutation((id: string) => api.todos({ id }).delete(), { onSuccess: nudge });
  const pending = create.isPending || patch.isPending || remove.isPending;
  const writable = !pending && status === "connected";
  const resetErrors = () => {
    create.reset();
    patch.reset();
    remove.reset();
  };
  const cancelEdit = () => setEdit({ id: undefined, draft: "" });
  return {
    todos: initialTodos.filter(
      (todo) => filter === "all" || todo.completed === (filter === "completed")
    ),
    total: initialTodos.length,
    remaining: initialTodos.filter((todo) => !todo.completed).length,
    completed: initialTodos.filter((todo) => todo.completed).length,
    filter,
    setFilter,
    draft,
    setDraft,
    editingId: edit.id,
    editDraft: edit.draft,
    setEditDraft: (value: string) => setEdit((current) => ({ ...current, draft: value })),
    pending,
    status,
    error:
      create.error?.value.detail ??
      patch.error?.value.detail ??
      remove.error?.value.detail ??
      (syncError ? `Synchronisation : ${syncError}` : undefined),
    add(value?: string) {
      const submitted = value ?? draft;
      if (writable && submitted.trim()) {
        resetErrors();
        create
          .mutateAsync({ title: submitted.trim() })
          .then(() => {
            setDraft((current) => (current === submitted ? "" : current));
            nudge();
          })
          .catch(() => undefined);
      }
    },
    toggle(todo: Todo) {
      if (writable) {
        resetErrors();
        patch.mutate(todo.id, { completed: !todo.completed });
      }
    },
    remove(id: string) {
      if (writable) {
        resetErrors();
        remove.mutate(id);
      }
    },
    startEdit(todo: Todo) {
      if (writable) {
        setEdit({ id: todo.id, draft: todo.title });
      }
    },
    cancelEdit,
    saveEdit(value?: string) {
      const { id } = edit;
      const submitted = value ?? edit.draft;
      if (writable && id && submitted.trim()) {
        resetErrors();
        patch
          .mutateAsync(id, { title: submitted.trim() })
          .then(() =>
            setEdit((current) =>
              current.id === id && current.draft === submitted
                ? { id: undefined, draft: "" }
                : current
            )
          )
          .catch(() => undefined);
      }
    },
  };
}
