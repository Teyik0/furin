import { useTodos } from "../use-todos";
import type { TodoScreenProps } from "../view-props";
import "./todo.css";

function focusEditor(element: HTMLInputElement | null) {
  element?.focus();
}

function emptyCopy(state: ReturnType<typeof useTodos>) {
  if (state.status === "connecting") {
    return ["Connexion en cours", "Vos tâches apparaîtront ici."];
  }
  if (state.filter === "completed") {
    return ["Aucune tâche terminée", "Les tâches terminées apparaîtront ici."];
  }
  if (state.filter === "active" && state.total > 0) {
    return ["Tout est fait", "Aucune tâche à faire pour le moment."];
  }
  return ["Aucune tâche", "Ajoutez une tâche avec le champ ci-dessus."];
}

export function TodoScreen({ todos: initialTodos }: TodoScreenProps) {
  const state = useTodos(initialTodos);
  const blocked = state.pending || state.status !== "connected";
  const statusLabel = {
    connecting: "Connexion en cours…",
    reconnecting: "Reconnexion en cours…",
    connected: state.pending ? "Enregistrement…" : "À jour",
  }[state.status];
  const [emptyTitle, emptyDescription] = emptyCopy(state);
  const filterTitle = {
    all: "Toutes les tâches",
    active: "À faire",
    completed: "Terminées",
  }[state.filter];

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
              ["all", "Toutes", state.total],
              ["active", "À faire", state.remaining],
              ["completed", "Terminées", state.completed],
            ] as const
          ).map(([filter, label, count]) => (
            <button
              aria-pressed={state.filter === filter}
              data-testid={`filter-${filter}`}
              key={filter}
              onClick={() => state.setFilter(filter)}
              type="button"
            >
              <span>{label}</span>
              <span className="todo-filter-count">{count}</span>
            </button>
          ))}
        </nav>
        <p className="todo-sidebar-note">Vos tâches, simplement.</p>
      </aside>
      <div className="todo-workspace">
        <header className="todo-header">
          <div>
            <p className="todo-eyebrow">TÂCHES</p>
            <h1 id="todo-heading">{filterTitle}</h1>
          </div>
          <span
            className={`todo-sync todo-sync--${state.status}`}
            data-testid="sync-status"
            role="status"
          >
            <span aria-hidden="true" className="todo-sync-dot" />
            {statusLabel}
          </span>
        </header>

        <form
          className="todo-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked && state.draft.trim()) {
              state.add();
            }
          }}
        >
          <label className="todo-sr-only" htmlFor="todo-title">
            Nouvelle tâche
          </label>
          <input
            autoComplete="off"
            data-testid="todo-title"
            id="todo-title"
            onChange={(event) => state.setDraft(event.target.value)}
            placeholder="Ajouter une tâche…"
            value={state.draft}
          />
          <button data-testid="add-todo" disabled={blocked || !state.draft.trim()} type="submit">
            <span aria-hidden="true">＋</span> Ajouter
          </button>
        </form>

        {state.status === "connected" ? null : (
          <p className="todo-connection-note">
            Vos tâches restent consultables. Vous pouvez préparer votre saisie pendant la connexion.
          </p>
        )}
        {state.error ? (
          <p className="todo-error" data-testid="todo-error" role="alert">
            {state.error}
          </p>
        ) : null}

        <div className="todo-list-heading">
          <span>LISTE DES TÂCHES</span>
          <span className="todo-total">
            {state.todos.length} tâche{state.todos.length === 1 ? "" : "s"}
          </span>
        </div>

        <section aria-label="Liste des tâches" className="todo-list-scroll">
          {state.todos.length === 0 ? (
            <div className="todo-empty">
              <h2>{emptyTitle}</h2>
              <p>{emptyDescription}</p>
            </div>
          ) : (
            <ul className="todo-list">
              {state.todos.map((todo) => (
                <li
                  className={todo.completed ? "todo-row todo-row--completed" : "todo-row"}
                  data-testid={`todo-row-${todo.id}`}
                  key={todo.id}
                >
                  <input
                    aria-label={`${todo.completed ? "Remettre à faire" : "Terminer"} : ${todo.title}`}
                    checked={todo.completed}
                    className="todo-checkbox"
                    data-testid={`toggle-${todo.id}`}
                    disabled={blocked}
                    onChange={() => state.toggle(todo)}
                    type="checkbox"
                  />
                  {state.editingId === todo.id ? (
                    <form
                      className="todo-edit"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!blocked && state.editDraft.trim()) {
                          state.saveEdit();
                        }
                      }}
                    >
                      <input
                        aria-label="Modifier le titre"
                        data-testid={`edit-title-${todo.id}`}
                        onChange={(event) => state.setEditDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            state.cancelEdit();
                          }
                        }}
                        ref={focusEditor}
                        value={state.editDraft}
                      />
                      <div className="todo-row-actions">
                        <button
                          data-testid={`save-${todo.id}`}
                          disabled={blocked || !state.editDraft.trim()}
                          type="submit"
                        >
                          Enregistrer
                        </button>
                        <button data-testid="cancel-edit" onClick={state.cancelEdit} type="button">
                          Annuler
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <span className="todo-row-title">{todo.title}</span>
                      <div className="todo-row-actions">
                        <button
                          aria-label={`Modifier : ${todo.title}`}
                          data-testid={`edit-${todo.id}`}
                          disabled={blocked}
                          onClick={() => state.startEdit(todo)}
                          type="button"
                        >
                          Modifier
                        </button>
                        <button
                          aria-label={`Supprimer : ${todo.title}`}
                          className="todo-delete"
                          data-testid={`delete-${todo.id}`}
                          disabled={blocked}
                          onClick={() => state.remove(todo.id)}
                          type="button"
                        >
                          Supprimer
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <footer className="todo-footer">
          <span>
            {state.remaining} à faire · {state.completed} terminée{state.completed === 1 ? "" : "s"}
          </span>
          <span>{state.total} au total</span>
        </footer>
      </div>
    </section>
  );
}
