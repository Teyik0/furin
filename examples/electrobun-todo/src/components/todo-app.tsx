import { useMutation } from "@teyik0/furin/client";
import { useState } from "react";
import type { ByIdPatch } from "../api/modules/todos/model";
import type { Todo } from "../db/schema";
import { api } from "../lib/api";
import "./todo.css";

type Filter = "all" | "active" | "completed";
type Changes = ByIdPatch["Body"];

const titles: { [filter in Filter]: string } = {
  all: "Toutes les tâches",
  active: "À faire",
  completed: "Terminées",
};

function focusEditor(element: HTMLInputElement | null) {
  element?.focus();
}

function emptyCopy(filter: Filter, total: number) {
  if (filter === "completed") {
    return ["Aucune tâche terminée", "Les tâches terminées apparaîtront ici."];
  }
  if (filter === "active" && total > 0) {
    return ["Tout est fait", "Aucune tâche à faire pour le moment."];
  }
  return ["Aucune tâche", "Ajoutez une tâche avec le champ ci-dessus."];
}

export function TodoApp({ todos }: { todos: Todo[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [draft, setDraft] = useState("");
  // Keep a draft edited while its creation request was pending.
  const create = useMutation(api.todos.post, {
    onSuccess: (todo) => setDraft((current) => (current.trim() === todo?.title ? "" : current)),
  });
  // Optimistic projections update the loader's `todos` prop; a rejection rolls them back.
  // The `{}` options argument lets the sync plugin attach an Idempotency-Key.
  const update = useMutation(
    (id: string, changes: Changes) => api.todos({ id }).patch(changes, {}),
    {
      optimistic: (cache, id, changes) =>
        cache.update(api.todos.get.live(), (list) =>
          list.map((todo) => (todo.id === id ? { ...todo, ...changes } : todo))
        ),
    }
  );
  const remove = useMutation((id: string) => api.todos({ id }).delete(undefined, {}), {
    optimistic: (cache, id) =>
      cache.update(api.todos.get.live(), (list) => list.filter((todo) => todo.id !== id)),
  });

  const pending = create.isPending || update.isPending || remove.isPending;
  const error = create.error ?? update.error ?? remove.error;
  const completed = todos.filter((todo) => todo.completed).length;
  const counts = { all: todos.length, active: todos.length - completed, completed };
  const visible = todos.filter(
    (todo) => filter === "all" || todo.completed === (filter === "completed")
  );
  const [emptyTitle, emptyDescription] = emptyCopy(filter, todos.length);

  return (
    <section aria-labelledby="todo-heading" className="todo-app">
      <aside className="todo-sidebar">
        <div className="todo-brand">
          <span aria-hidden="true" className="todo-brand-mark">
            r.
          </span>
          Relay
        </div>
        <p className="todo-nav-label">ESPACE DE TRAVAIL</p>
        <nav aria-label="Filtrer les tâches" className="todo-filters">
          {(
            [
              ["all", "Toutes"],
              ["active", "À faire"],
              ["completed", "Terminées"],
            ] as const
          ).map(([value, label]) => (
            <button
              aria-pressed={filter === value}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              <span>{label}</span>
              <span className="todo-filter-count">{counts[value]}</span>
            </button>
          ))}
        </nav>
        <p className="todo-sidebar-note">Vos tâches, simplement.</p>
      </aside>
      <div className="todo-workspace">
        <header className="todo-header">
          <div>
            <p className="todo-eyebrow">TÂCHES</p>
            <h1 id="todo-heading">{titles[filter]}</h1>
          </div>
          <span className={pending ? "todo-sync todo-sync--saving" : "todo-sync"} role="status">
            <span aria-hidden="true" className="todo-sync-dot" />
            {pending ? "Enregistrement…" : "À jour"}
          </span>
        </header>

        <form
          className="todo-create"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate({ title: draft.trim() });
          }}
        >
          <label className="todo-sr-only" htmlFor="todo-title">
            Nouvelle tâche
          </label>
          <input
            autoComplete="off"
            id="todo-title"
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ajouter une tâche…"
            value={draft}
          />
          <button disabled={create.isPending || !draft.trim()} type="submit">
            <span aria-hidden="true">＋</span> Ajouter
          </button>
        </form>

        {error ? (
          <p className="todo-error" role="alert">
            {error.value.detail}
          </p>
        ) : null}

        <div className="todo-list-heading">
          <span>LISTE DES TÂCHES</span>
          <span className="todo-total">
            {visible.length} tâche{visible.length === 1 ? "" : "s"}
          </span>
        </div>

        <section aria-label="Liste des tâches" className="todo-list-scroll">
          {visible.length === 0 ? (
            <div className="todo-empty">
              <h2>{emptyTitle}</h2>
              <p>{emptyDescription}</p>
            </div>
          ) : (
            <ul className="todo-list">
              {visible.map((todo) => (
                <TodoItem
                  key={todo.id}
                  onRemove={() => remove.mutate(todo.id)}
                  onUpdate={(changes) => update.mutate(todo.id, changes)}
                  todo={todo}
                />
              ))}
            </ul>
          )}
        </section>
        <footer className="todo-footer">
          <span>
            {counts.active} à faire · {completed} terminée{completed === 1 ? "" : "s"}
          </span>
          <span>{todos.length} au total</span>
        </footer>
      </div>
    </section>
  );
}

function TodoItem({
  todo,
  onUpdate,
  onRemove,
}: {
  todo: Todo;
  onUpdate: (changes: Changes) => void;
  onRemove: () => void;
}) {
  // `null` while the title is not being edited.
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <li className={todo.completed ? "todo-row todo-row--completed" : "todo-row"}>
      <input
        aria-label={`${todo.completed ? "Remettre à faire" : "Terminer"} : ${todo.title}`}
        checked={todo.completed}
        className="todo-checkbox"
        onChange={() => onUpdate({ completed: !todo.completed })}
        type="checkbox"
      />
      {draft === null ? (
        <>
          <span className="todo-row-title">{todo.title}</span>
          <div className="todo-row-actions">
            <button
              aria-label={`Modifier : ${todo.title}`}
              onClick={() => setDraft(todo.title)}
              type="button"
            >
              Modifier
            </button>
            <button
              aria-label={`Supprimer : ${todo.title}`}
              className="todo-delete"
              onClick={onRemove}
              type="button"
            >
              Supprimer
            </button>
          </div>
        </>
      ) : (
        <form
          className="todo-edit"
          onSubmit={(event) => {
            event.preventDefault();
            onUpdate({ title: draft.trim() });
            setDraft(null);
          }}
        >
          <input
            aria-label="Modifier le titre"
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(null);
              }
            }}
            ref={focusEditor}
            value={draft}
          />
          <div className="todo-row-actions">
            <button disabled={!draft.trim()} type="submit">
              Enregistrer
            </button>
            <button onClick={() => setDraft(null)} type="button">
              Annuler
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
