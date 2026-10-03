import { useMutation } from "@teyik0/furin/client";
import { Link } from "@teyik0/furin/link";
import { domAnimation, LazyMotion, MotionConfig, m } from "framer-motion";
import { type DragEvent, useRef, useState } from "react";
import { FaFire } from "react-icons/fa";
import { FiArrowUpRight, FiPlus, FiTrash } from "react-icons/fi";
import type { BoardData } from "@/db/schema";
import { api } from "@/lib/api";
import { moveCard } from "@/lib/card-mutations";
import { cn } from "../../lib/utils";

interface KanbanProps {
  boardId: string;
  initialCards: BoardData["cards"];
}

const columns = [
  { column: "backlog", headingColor: "text-neutral-400", title: "Backlog" },
  { column: "todo", headingColor: "text-yellow-300", title: "TODO" },
  { column: "doing", headingColor: "text-blue-300", title: "In Progress" },
  { column: "done", headingColor: "text-emerald-300", title: "Complete" },
] as const;

interface MoveInput {
  before: string;
  cardId: string;
  column: ColumnType;
  position: number;
}

export const Kanban = ({ boardId, initialCards }: KanbanProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const move = useMutation(({ cardId, column, position, before }: MoveInput) =>
    api.cards({ id: cardId }).patch(
      { column, position },
      {
        optimistic: (cache) =>
          cache.update(api.boards({ boardId }).get, (data) => ({
            ...data,
            cards: moveCard(data.cards, cardId, column, before)?.nextCards ?? data.cards,
          })),
      }
    )
  );
  const remove = useMutation((cardId: string) =>
    api.cards({ id: cardId }).delete(undefined, {
      optimistic: (cache) =>
        cache.update(api.boards({ boardId }).get, (data) => ({
          ...data,
          cards: data.cards.filter((card) => card.id !== cardId),
        })),
    })
  );

  const handleMove = (cardId: string, column: ColumnType, before: string) => {
    if (before === cardId) {
      return;
    }
    const result = moveCard(initialCards, cardId, column, before);
    if (!result) {
      return;
    }
    const position = result.nextCards
      .filter((card) => card.column === column)
      .findIndex((card) => card.id === cardId);
    move.mutate({ cardId, column, position, before });
  };
  const handleDragStart = () => setIsDragging(true);
  const handleDragEnd = () => setIsDragging(false);

  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">
        {move.error ? (
          <div className="mx-6 mt-6 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-red-300 text-sm">
            Could not move the card. Please try again.
          </div>
        ) : null}
        {remove.error ? (
          <div className="mx-6 mt-6 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-red-300 text-sm">
            Could not delete the card. Please try again.
          </div>
        ) : null}

        <div className="flex h-full w-full gap-4 overflow-x-auto p-6">
          {columns.map((column) => (
            <Column
              key={column.column}
              {...column}
              boardId={boardId}
              cards={initialCards}
              onDragEnd={handleDragEnd}
              onDragStart={handleDragStart}
              onMove={handleMove}
            />
          ))}
        </div>

        <BurnBarrel isDragging={isDragging} onDelete={remove.mutate} onDragEnd={handleDragEnd} />
      </MotionConfig>
    </LazyMotion>
  );
};

export type ColumnType = "backlog" | "todo" | "doing" | "done";
export interface KanbanCard {
  column: ColumnType;
  id: string;
  title: string;
}
interface ColumnProps {
  boardId: string;
  cards: KanbanCard[];
  column: ColumnType;
  headingColor: string;
  onDragEnd: () => void;
  onDragStart: () => void;
  onMove: (cardId: string, column: ColumnType, before: string) => void;
  title: string;
}

const Column = ({
  title,
  headingColor,
  cards,
  column,
  boardId,
  onDragEnd,
  onDragStart,
  onMove,
}: ColumnProps) => {
  const [active, setActive] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const handleDragStart = (e: DragEvent, card: KanbanCard) => {
    e.dataTransfer.setData("cardId", card.id);
    onDragStart();
  };

  const handleDrop = (e: DragEvent) => {
    const cardId = e.dataTransfer.getData("cardId");

    setActive(false);
    onDragEnd();
    clearHighlights();

    const indicators = getIndicators();
    const { element } = getNearestIndicator(e.clientY, indicators);
    if (!element) {
      return;
    }

    const before = element.dataset.before ?? "-1";
    onMove(cardId, column, before);
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
    const el = getNearestIndicator(e.clientY, indicators);
    if (!el.element) {
      return;
    }
    el.element.style.opacity = "1";
  };

  const getIndicators = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-column]") ?? []);

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
        onDrop={handleDrop}
        ref={listRef}
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

function getNearestIndicator(clientY: number, indicators: HTMLElement[]) {
  const lastIndicator = indicators.at(-1);
  if (!lastIndicator) {
    return { element: null, offset: Number.NEGATIVE_INFINITY };
  }

  const DISTANCE_OFFSET = 50;
  return indicators.reduce(
    (closest, child) => {
      const offset = clientY - (child.getBoundingClientRect().top + DISTANCE_OFFSET);
      return offset < 0 && offset > closest.offset ? { element: child, offset } : closest;
    },
    { element: lastIndicator, offset: Number.NEGATIVE_INFINITY }
  );
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
        params={{ boardId, cardId: id }}
        title="Open card"
        to="/board/:boardId/card/:cardId"
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
  isDragging: boolean;
  onDelete: (cardId: string) => void;
  onDragEnd: () => void;
}

const BurnBarrel = ({ isDragging, onDelete, onDragEnd }: BurnBarrelProps) => {
  const [active, setActive] = useState(false);

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setActive(true);
  };

  const handleDragLeave = () => {
    setActive(false);
  };

  const handleDrop = (e: DragEvent) => {
    const cardId = e.dataTransfer.getData("cardId");
    setActive(false);
    onDragEnd();

    if (!cardId) {
      return;
    }

    onDelete(cardId);
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

interface AddCardFormProps extends AddCardProps {
  onClose: () => void;
}

const AddCardForm = ({ column, boardId, onClose }: AddCardFormProps) => {
  const [text, setText] = useState("");
  const add = useMutation(api.boards({ boardId }).cards.post, { onSuccess: onClose });
  const handleSubmit = (formData: FormData) => {
    const title = String(formData.get("title") ?? "").trim();
    if (!title) {
      return;
    }

    add.mutate(
      { column, title },
      {
        optimistic: (cache) =>
          cache.update(api.boards({ boardId }).get, (data) => ({
            ...data,
            cards: [
              ...data.cards,
              {
                boardId,
                column,
                createdAt: new Date().toISOString(),
                description: "",
                id: crypto.randomUUID(),
                position: data.cards.filter((card) => card.column === column).length,
                title,
              },
            ],
          })),
      }
    );
  };

  return (
    <m.form action={handleSubmit} className="mt-1.5" layout>
      {add.error ? (
        <p className="mb-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-red-300 text-xs">
          {(add.error.status === 0 ? null : add.error.value?.detail) ??
            "Could not create the card. Please try again."}
        </p>
      ) : null}
      <textarea
        aria-label="New task content"
        className={cn(
          "w-full rounded-lg border border-violet-500/40 bg-violet-500/8 p-2.5 text-sm",
          "resize-none text-neutral-200 placeholder-neutral-600 focus:outline-none"
        )}
        disabled={add.isPending}
        name="title"
        onChange={(e) => setText(e.target.value)}
        placeholder="Add new task..."
        rows={2}
        value={text}
      />
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <button
          className="px-3 py-1.5 text-neutral-600 text-xs transition-colors hover:text-neutral-400"
          disabled={add.isPending}
          onClick={onClose}
          type="button"
        >
          Cancel
        </button>
        <button
          className={cn(
            "flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5",
            "font-medium text-white text-xs transition-colors hover:bg-violet-500"
          )}
          disabled={add.isPending}
          type="submit"
        >
          <span>{add.isPending ? "Adding…" : "Add"}</span>
          <FiPlus />
        </button>
      </div>
    </m.form>
  );
};

const AddCard = ({ column, boardId }: AddCardProps) => {
  const [adding, setAdding] = useState(false);

  return adding ? (
    <AddCardForm boardId={boardId} column={column} onClose={() => setAdding(false)} />
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
  );
};
