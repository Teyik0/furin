import { Link } from "@teyik0/furin/link";
import { motion } from "framer-motion";
import {
  type Dispatch,
  type DragEvent,
  type SetStateAction,
  type SyntheticEvent,
  useState,
} from "react";
import { FaFire } from "react-icons/fa";
import { FiArrowUpRight, FiPlus, FiTrash } from "react-icons/fi";
import { apiClient } from "@/lib/api";
import { cn } from "../../lib/utils";

export type ColumnType = "backlog" | "todo" | "doing" | "done";

export interface KanbanCard {
  column: ColumnType;
  id: string;
  title: string;
}

interface KanbanProps {
  boardId: string;
  initialCards: KanbanCard[];
  onMutation?: () => void;
}

function moveCard(
  cards: KanbanCard[],
  cardId: string,
  nextColumn: ColumnType,
  before: string
): {
  nextCards: KanbanCard[];
  previousColumn: ColumnType;
  previousIndex: number;
} | null {
  let nextCards = [...cards];
  let cardToTransfer = nextCards.find((card) => card.id === cardId);
  const previousIndex = nextCards.findIndex((card) => card.id === cardId);
  if (!(cardToTransfer && previousIndex !== -1)) {
    return null;
  }

  const previousColumn = cardToTransfer.column;
  cardToTransfer = { ...cardToTransfer, column: nextColumn };
  nextCards = nextCards.filter((card) => card.id !== cardId);

  if (before === "-1") {
    nextCards.push(cardToTransfer);
    return { nextCards, previousColumn, previousIndex };
  }

  const insertAtIndex = nextCards.findIndex((card) => card.id === before);
  if (insertAtIndex === -1) {
    return null;
  }

  nextCards.splice(insertAtIndex, 0, cardToTransfer);
  return { nextCards, previousColumn, previousIndex };
}

function rollbackMovedCard(
  cards: KanbanCard[],
  cardId: string,
  failedColumn: ColumnType,
  previousColumn: ColumnType,
  previousIndex: number
): KanbanCard[] {
  const currentIndex = cards.findIndex((card) => card.id === cardId);
  if (currentIndex === -1) {
    return cards;
  }

  const currentCard = cards[currentIndex];
  if (!(currentCard && currentCard.column === failedColumn)) {
    return cards;
  }

  const nextCards = [...cards];
  nextCards.splice(currentIndex, 1);

  const restoreIndex = Math.min(previousIndex, nextCards.length);
  nextCards.splice(restoreIndex, 0, { ...currentCard, column: previousColumn });
  return nextCards;
}

function restoreDeletedCard(
  cards: KanbanCard[],
  deletedCard: KanbanCard,
  deletedIndex: number
): KanbanCard[] {
  if (cards.some((card) => card.id === deletedCard.id)) {
    return cards;
  }

  const nextCards = [...cards];
  const restoreIndex = Math.min(deletedIndex, nextCards.length);
  nextCards.splice(restoreIndex, 0, deletedCard);
  return nextCards;
}

export const Kanban = ({ initialCards, boardId, onMutation }: KanbanProps) => {
  const [cards, setCards] = useState<KanbanCard[]>(initialCards);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  return (
    <>
      {errorMessage ? (
        <div className="mx-6 mt-6 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-red-300 text-sm">
          {errorMessage}
        </div>
      ) : null}

      <div className="flex h-full w-full gap-4 overflow-x-auto p-6">
        <Column
          boardId={boardId}
          cards={cards}
          column="backlog"
          headingColor="text-neutral-400"
          onMutation={onMutation}
          setCards={setCards}
          setErrorMessage={setErrorMessage}
          setIsDragging={setIsDragging}
          title="Backlog"
        />
        <Column
          boardId={boardId}
          cards={cards}
          column="todo"
          headingColor="text-yellow-300"
          onMutation={onMutation}
          setCards={setCards}
          setErrorMessage={setErrorMessage}
          setIsDragging={setIsDragging}
          title="TODO"
        />
        <Column
          boardId={boardId}
          cards={cards}
          column="doing"
          headingColor="text-blue-300"
          onMutation={onMutation}
          setCards={setCards}
          setErrorMessage={setErrorMessage}
          setIsDragging={setIsDragging}
          title="In Progress"
        />
        <Column
          boardId={boardId}
          cards={cards}
          column="done"
          headingColor="text-emerald-300"
          onMutation={onMutation}
          setCards={setCards}
          setErrorMessage={setErrorMessage}
          setIsDragging={setIsDragging}
          title="Complete"
        />
      </div>

      {/* Floating burn barrel — only visible while dragging */}
      <BurnBarrel
        cards={cards}
        isDragging={isDragging}
        onMutation={onMutation}
        setCards={setCards}
        setErrorMessage={setErrorMessage}
        setIsDragging={setIsDragging}
      />
    </>
  );
};

// ---------------------------------------------------------------------------
// Column
// ---------------------------------------------------------------------------

interface ColumnProps {
  boardId: string;
  cards: KanbanCard[];
  column: ColumnType;
  headingColor: string;
  onMutation?: () => void;
  setCards: Dispatch<SetStateAction<KanbanCard[]>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setIsDragging: Dispatch<SetStateAction<boolean>>;
  title: string;
}

const Column = ({
  title,
  headingColor,
  cards,
  column,
  setErrorMessage,
  setCards,
  boardId,
  setIsDragging,
  onMutation,
}: ColumnProps) => {
  const [active, setActive] = useState(false);

  const handleDragStart = (e: DragEvent, card: KanbanCard) => {
    e.dataTransfer.setData("cardId", card.id);
    setIsDragging(true);
  };

  const handleDragEnd = async (e: DragEvent) => {
    const cardId = e.dataTransfer.getData("cardId");

    setActive(false);
    setIsDragging(false);
    clearHighlights();

    const indicators = getIndicators();
    const { element } = getNearestIndicator(e, indicators);
    if (!element) {
      return;
    }

    const before = element.dataset.before ?? "-1";
    if (before === cardId) {
      return;
    }

    // Compute the move synchronously so we can read previousColumn/Index for
    // rollback.  The optimistic state update itself uses a functional form so
    // it is applied on top of the freshest state rather than overwriting any
    // concurrent card additions or moves made since the last render.
    const moveResult = moveCard(cards, cardId, column, before);
    if (!moveResult) {
      return;
    }

    const { previousColumn, previousIndex } = moveResult;

    // New position = 0-based index within the destination column after the move
    const destColumnCards = moveResult.nextCards.filter((c) => c.column === column);
    const newPosition = destColumnCards.findIndex((c) => c.id === cardId);

    setCards((prevCards) => moveCard(prevCards, cardId, column, before)?.nextCards ?? prevCards);
    setErrorMessage(null);

    // Always PATCH — cross-column moves update column+position, same-column
    // reorders update position only so the order is preserved across refreshes.
    const { error } = await apiClient.api.cards({ id: cardId }).patch({
      column,
      position: newPosition,
    });

    if (error) {
      setCards((currentCards) =>
        rollbackMovedCard(currentCards, cardId, column, previousColumn, previousIndex)
      );
      setErrorMessage("Could not move the card. The board has been restored.");
      return;
    }

    onMutation?.();

    // Recompute sequential positions for every card in the affected column(s)
    // so DB positions stay contiguous and reflect the visual order.
    // These are fire-and-forget — the UI is already correct.
    for (const [idx, c] of destColumnCards.entries()) {
      if (c.id !== cardId) {
        apiClient.api.cards({ id: c.id }).patch({ position: idx });
      }
    }
    if (previousColumn !== column) {
      const srcColumnCards = moveResult.nextCards.filter((c) => c.column === previousColumn);
      for (const [idx, c] of srcColumnCards.entries()) {
        apiClient.api.cards({ id: c.id }).patch({ position: idx });
      }
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    highlightIndicator(e);
    setActive(true);
  };

  const clearHighlights = (els?: HTMLElement[]) => {
    const indicators = els ?? getIndicators();
    for (const i of indicators) {
      i.style.opacity = "0";
    }
  };

  const highlightIndicator = (e: DragEvent) => {
    const indicators = getIndicators();
    clearHighlights(indicators);
    const el = getNearestIndicator(e, indicators);
    if (!el.element) {
      return;
    }
    el.element.style.opacity = "1";
  };

  const getNearestIndicator = (e: DragEvent, indicators: HTMLElement[]) => {
    const lastIndicator = indicators.at(-1);
    if (!lastIndicator) {
      return {
        offset: Number.NEGATIVE_INFINITY,
        element: null,
      };
    }

    const DISTANCE_OFFSET = 50;
    return indicators.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = e.clientY - (box.top + DISTANCE_OFFSET);
        if (offset < 0 && offset > closest.offset) {
          return { offset, element: child };
        }
        return closest;
      },
      {
        offset: Number.NEGATIVE_INFINITY,
        element: lastIndicator,
      }
    );
  };

  const getIndicators = () => {
    return Array.from(
      document.querySelectorAll(`[data-column="${column}"]`) as unknown as HTMLElement[]
    );
  };

  const handleDragLeave = () => {
    clearHighlights();
    setActive(false);
  };

  const filteredCards = cards.filter((c) => c.column === column);

  return (
    <div className="w-56 shrink-0">
      <div className="mb-3 flex items-center justify-between">
        <h3 className={cn("font-semibold text-xs uppercase tracking-widest", headingColor)}>
          {title}
        </h3>
        <span className="rounded-full bg-white/5 px-2 py-0.5 font-medium text-neutral-500 text-xs tabular-nums">
          {filteredCards.length}
        </span>
      </div>

      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: drop zone requires drag events on non-interactive element */}
      <ul
        className={cn(
          "min-h-20 w-full list-none rounded-xl p-1 transition-colors duration-150",
          active ? "bg-white/4" : "bg-transparent"
        )}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDragEnd}
      >
        {filteredCards.map((c) => (
          <Card key={c.id} {...c} boardId={boardId} handleDragStart={handleDragStart} />
        ))}
        <DropIndicator beforeId={null} column={column} />
        <AddCard boardId={boardId} column={column} onMutation={onMutation} setCards={setCards} />
      </ul>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps extends KanbanCard {
  boardId: string;
  handleDragStart: (e: DragEvent, card: KanbanCard) => void;
}

const Card = ({ title, id, column, boardId, handleDragStart }: CardProps) => {
  return (
    <>
      <DropIndicator beforeId={id} column={column} />
      <motion.div
        className={cn(
          "group relative mb-1.5 cursor-grab rounded-lg border border-white/6 bg-white/4 p-3",
          "shadow-sm active:cursor-grabbing",
          "transition-colors duration-100 hover:border-white/10 hover:bg-white/6"
        )}
        draggable="true"
        layout
        layoutId={id}
        onDragStart={(e) => handleDragStart(e as unknown as DragEvent, { title, id, column })}
      >
        <p className="pr-5 text-neutral-200 text-sm leading-snug">{title}</p>

        {/* Open detail page — visible on hover, doesn't interfere with drag */}
        <Link
          className={cn(
            "absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded",
            "opacity-0 transition-opacity duration-100 group-hover:opacity-100",
            "bg-white/8 text-neutral-500 hover:bg-violet-500/20 hover:text-violet-400"
          )}
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => e.preventDefault()}
          title="Open card"
          to={`/board/${boardId}/card/${id}`}
        >
          <FiArrowUpRight size={11} />
        </Link>
      </motion.div>
    </>
  );
};

// ---------------------------------------------------------------------------
// DropIndicator
// ---------------------------------------------------------------------------

interface DropIndicatorProps {
  beforeId: string | null;
  column: string;
}

const DropIndicator = ({ beforeId, column }: DropIndicatorProps) => {
  return (
    <div
      className="my-0.5 h-0.5 w-full rounded-full bg-violet-500 opacity-0 transition-opacity"
      data-before={beforeId ?? "-1"}
      data-column={column}
    />
  );
};

// ---------------------------------------------------------------------------
// BurnBarrel — floating, fixed position, visible only while dragging
// ---------------------------------------------------------------------------

interface BurnBarrelProps {
  cards: KanbanCard[];
  isDragging: boolean;
  onMutation?: () => void;
  setCards: Dispatch<SetStateAction<KanbanCard[]>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setIsDragging: Dispatch<SetStateAction<boolean>>;
}

const BurnBarrel = ({
  setCards,
  isDragging,
  setErrorMessage,
  setIsDragging,
  onMutation,
}: BurnBarrelProps) => {
  const [active, setActive] = useState(false);

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setActive(true);
  };

  const handleDragLeave = () => {
    setActive(false);
  };

  const handleDrop = async (e: DragEvent) => {
    const cardId = e.dataTransfer.getData("cardId");
    setActive(false);
    setIsDragging(false);

    if (!cardId) {
      return;
    }

    // Capture the card snapshot and its index from inside the functional
    // update so we always read the freshest state — not a potentially stale
    // closure value captured at render time.  This prevents the rollback from
    // restoring an outdated card or inserting it at an index that no longer
    // matches the current list after concurrent operations.
    let deletedCard: KanbanCard | undefined;
    let deletedIndex = -1;

    setCards((prevCards) => {
      const idx = prevCards.findIndex((c) => c.id === cardId);
      if (idx !== -1) {
        deletedCard = prevCards[idx];
        deletedIndex = idx;
      }
      return prevCards.filter((c) => c.id !== cardId);
    });

    if (!deletedCard || deletedIndex === -1) {
      return;
    }

    // Freeze into new bindings so TypeScript knows they are non-undefined
    // inside the async continuation below.
    const capturedCard = deletedCard;
    const capturedIndex = deletedIndex;

    setErrorMessage(null);
    const { error } = await apiClient.api.cards({ id: cardId }).delete();
    if (error) {
      setCards((currentCards) => restoreDeletedCard(currentCards, capturedCard, capturedIndex));
      setErrorMessage("Could not delete the card. It has been restored.");
      return;
    }

    onMutation?.();
  };

  return (
    <button
      aria-label="Delete card — drop a card here to remove it"
      className={cn(
        "fixed right-6 bottom-6 z-50",
        "grid h-14 w-14 place-content-center rounded-full",
        "border text-lg backdrop-blur-md",
        "transition-all duration-200",
        isDragging ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
        active
          ? "scale-125 border-red-500/70 bg-red-500/20 text-red-400 shadow-lg shadow-red-500/20"
          : "border-white/10 bg-neutral-900/80 text-neutral-500"
      )}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{ pointerEvents: isDragging ? "auto" : "none" }}
      type="button"
    >
      {active ? <FaFire className="animate-bounce" /> : <FiTrash size={16} />}
    </button>
  );
};

// ---------------------------------------------------------------------------
// AddCard
// ---------------------------------------------------------------------------

interface AddCardProps {
  boardId: string;
  column: ColumnType;
  onMutation?: () => void;
  setCards: Dispatch<SetStateAction<KanbanCard[]>>;
}

const AddCard = ({ column, setCards, boardId, onMutation }: AddCardProps) => {
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const handleSubmit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!text.trim().length) {
      return;
    }

    setAddError(null);
    const { data: newCard, error } = await apiClient.api.boards({ boardId }).cards.post({
      title: text.trim(),
      column,
    });
    if (!newCard || error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : "Could not create the card. Please try again.";
      setAddError(message);
      return; // keep the form open so the user can retry
    }

    setCards((pv) => [...pv, { id: newCard.id, title: newCard.title, column }]);
    onMutation?.();

    setText("");
    setAdding(false);
  };

  return (
    <>
      {adding ? (
        <motion.form className="mt-1.5" layout onSubmit={handleSubmit}>
          {addError ? (
            <p className="mb-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-red-300 text-xs">
              {addError}
            </p>
          ) : null}
          <textarea
            autoFocus
            className={cn(
              "w-full rounded-lg border border-violet-500/40 bg-violet-500/8 p-2.5 text-sm",
              "resize-none text-neutral-200 placeholder-neutral-600 focus:outline-none"
            )}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add new task..."
            rows={2}
            value={text}
          />
          <div className="mt-1.5 flex items-center justify-end gap-1.5">
            <button
              className="px-3 py-1.5 text-neutral-600 text-xs transition-colors hover:text-neutral-400"
              onClick={() => {
                setAdding(false);
                setAddError(null);
              }}
              type="button"
            >
              Cancel
            </button>
            <button
              className={cn(
                "flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5",
                "font-medium text-white text-xs transition-colors hover:bg-violet-500"
              )}
              type="submit"
            >
              <span>Add</span>
              <FiPlus />
            </button>
          </div>
        </motion.form>
      ) : (
        <motion.button
          className={cn(
            "mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5",
            "text-neutral-700 text-xs transition-colors hover:text-neutral-500",
            "hover:bg-white/4"
          )}
          layout
          onClick={() => setAdding(true)}
        >
          <FiPlus className="shrink-0" />
          <span>Add card</span>
        </motion.button>
      )}
    </>
  );
};
