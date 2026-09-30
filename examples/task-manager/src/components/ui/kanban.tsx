import { Link } from "@teyik0/furin/link";
import { domAnimation, LazyMotion, MotionConfig, m } from "framer-motion";
import { type Dispatch, type DragEvent, type SetStateAction, useState } from "react";
import { FaFire } from "react-icons/fa";
import { FiArrowUpRight, FiPlus, FiTrash } from "react-icons/fi";
import type { BoardData } from "@/db/schema";
import { api } from "@/lib/api";
import { cn } from "../../lib/utils";

export type ColumnType = "backlog" | "todo" | "doing" | "done";

export interface KanbanCard {
  column: ColumnType;
  id: string;
  title: string;
}

function moveCard<Card extends KanbanCard>(
  cards: Card[],
  cardId: string,
  nextColumn: ColumnType,
  before: string
): {
  nextCards: Card[];
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

interface KanbanProps {
  boardId: string;
  initialCards: BoardData["cards"];
}
export const Kanban = ({ boardId, initialCards }: KanbanProps) => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const cards = initialCards;

  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">
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
            setErrorMessage={setErrorMessage}
            setIsDragging={setIsDragging}
            title="Backlog"
          />
          <Column
            boardId={boardId}
            cards={cards}
            column="todo"
            headingColor="text-yellow-300"
            setErrorMessage={setErrorMessage}
            setIsDragging={setIsDragging}
            title="TODO"
          />
          <Column
            boardId={boardId}
            cards={cards}
            column="doing"
            headingColor="text-blue-300"
            setErrorMessage={setErrorMessage}
            setIsDragging={setIsDragging}
            title="In Progress"
          />
          <Column
            boardId={boardId}
            cards={cards}
            column="done"
            headingColor="text-emerald-300"
            setErrorMessage={setErrorMessage}
            setIsDragging={setIsDragging}
            title="Complete"
          />
        </div>

        <BurnBarrel
          boardId={boardId}
          isDragging={isDragging}
          setErrorMessage={setErrorMessage}
          setIsDragging={setIsDragging}
        />
      </MotionConfig>
    </LazyMotion>
  );
};

interface ColumnProps {
  boardId: string;
  cards: KanbanCard[];
  column: ColumnType;
  headingColor: string;
  onMutation?: () => void;
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
  boardId,
  setIsDragging,
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

    const moveResult = moveCard(cards, cardId, column, before);
    if (!moveResult) {
      return;
    }

    const destColumnCards = moveResult.nextCards.filter((c) => c.column === column);
    const newPosition = destColumnCards.findIndex((c) => c.id === cardId);

    setErrorMessage(null);
    const { error } = await api.cards({ id: cardId }).patch(
      {
        column,
        position: newPosition,
      },
      {
        optimistic: (cache) =>
          cache.update(`/board/${boardId}`, (loader) => ({
            ...loader,
            initialCards:
              moveCard(loader.initialCards, cardId, column, before)?.nextCards ??
              loader.initialCards,
          })),
      }
    );
    if (error) {
      setErrorMessage("Could not move the card. Please try again.");
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

  // react-doctor-disable-next-line react-doctor/prefer-module-scope-pure-function
  const getNearestIndicator = (e: DragEvent, indicators: HTMLElement[]) => {
    const lastIndicator = indicators.at(-1);
    if (!lastIndicator) {
      return {
        element: null,
        offset: Number.NEGATIVE_INFINITY,
      };
    }

    const DISTANCE_OFFSET = 50;
    return indicators.reduce(
      (closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = e.clientY - (box.top + DISTANCE_OFFSET);
        if (offset < 0 && offset > closest.offset) {
          return { element: child, offset };
        }
        return closest;
      },
      {
        element: lastIndicator,
        offset: Number.NEGATIVE_INFINITY,
      }
    );
  };

  const getIndicators = () =>
    Array.from(document.querySelectorAll(`[data-column="${column}"]`) as unknown as HTMLElement[]);

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
        <AddCard boardId={boardId} column={column} />
      </ul>
    </div>
  );
};

interface CardProps extends KanbanCard {
  boardId: string;
  handleDragStart: (e: DragEvent, card: KanbanCard) => void;
}

const Card = ({ title, id, column, boardId, handleDragStart }: CardProps) => (
  <>
    <DropIndicator beforeId={id} column={column} />
    <m.div
      className={cn(
        "group relative mb-1.5 cursor-grab rounded-lg border border-white/6 bg-white/4 p-3",
        "shadow-sm active:cursor-grabbing",
        "transition-colors duration-100 hover:border-white/10 hover:bg-white/6"
      )}
      draggable="true"
      layout
      layoutId={id}
      onDragStart={(e) => handleDragStart(e as unknown as DragEvent, { column, id, title })}
    >
      <p className="pr-5 text-neutral-200 text-sm leading-snug">{title}</p>

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
    </m.div>
  </>
);

interface DropIndicatorProps {
  beforeId: string | null;
  column: string;
}

const DropIndicator = ({ beforeId, column }: DropIndicatorProps) => (
  <div
    className="my-0.5 h-0.5 w-full rounded-full bg-violet-500 opacity-0 transition-opacity"
    data-before={beforeId ?? "-1"}
    data-column={column}
  />
);

interface BurnBarrelProps {
  boardId: string;
  isDragging: boolean;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setIsDragging: Dispatch<SetStateAction<boolean>>;
}

const BurnBarrel = ({ boardId, isDragging, setErrorMessage, setIsDragging }: BurnBarrelProps) => {
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

    setErrorMessage(null);
    const { error } = await api.cards({ id: cardId }).delete(undefined, {
      optimistic: (cache) =>
        cache.update(`/board/${boardId}`, (loader) => ({
          ...loader,
          initialCards: loader.initialCards.filter((card) => card.id !== cardId),
        })),
    });
    if (error) {
      setErrorMessage("Could not delete the card. Please try again.");
    }
  };

  return (
    <button
      aria-label="Delete card — drop a card here to remove it"
      className={cn(
        "fixed right-6 bottom-6 z-50",
        "grid h-14 w-14 place-content-center rounded-full",
        "border text-lg backdrop-blur-md",
        "transition-[translate,scale,opacity,color,background-color,border-color,box-shadow] duration-200",
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
      {active ? <FaFire className="animate-pulse" /> : <FiTrash size={16} />}
    </button>
  );
};

interface AddCardProps {
  boardId: string;
  column: ColumnType;
}

const AddCard = ({ column, boardId }: AddCardProps) => {
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const handleSubmit = async () => {
    if (!text.trim().length) {
      return;
    }

    setAddError(null);
    const temporaryId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const title = text.trim();
    const { data: newCard, error } = await api.boards({ boardId }).cards.post(
      { column, title },
      {
        optimistic: (cache) =>
          cache.update(`/board/${boardId}`, (loader) => ({
            ...loader,
            initialCards: [
              ...loader.initialCards,
              {
                boardId,
                column,
                createdAt,
                description: "",
                id: temporaryId,
                position: loader.initialCards.filter((card) => card.column === column).length,
                title,
              },
            ],
          })),
      }
    );
    if (!newCard || newCard instanceof Response || error) {
      const message =
        error?.value && "detail" in error.value
          ? (error.value.detail ?? "Could not create the card. Please try again.")
          : "Could not create the card. Please try again.";
      setAddError(message);
      return;
    }

    setText("");
    setAdding(false);
  };

  return (
    <>
      {adding ? (
        <m.form action={handleSubmit} className="mt-1.5" layout>
          {addError ? (
            <p className="mb-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-red-300 text-xs">
              {addError}
            </p>
          ) : null}
          <textarea
            aria-label="New task content"
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
        </m.form>
      ) : (
        <m.button
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
        </m.button>
      )}
    </>
  );
};
