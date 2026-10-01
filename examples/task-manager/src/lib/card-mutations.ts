import type { ColumnType, KanbanCard } from "@/components/ui/kanban";
import { api } from "@/lib/api";

export function moveCard<Card extends KanbanCard>(
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
  } else {
    const insertAtIndex = nextCards.findIndex((card) => card.id === before);
    if (insertAtIndex === -1) {
      return null;
    }
    nextCards.splice(insertAtIndex, 0, cardToTransfer);
  }
  const positions = new Map<ColumnType, number>();
  nextCards = nextCards.map((card) => {
    if (card.column !== previousColumn && card.column !== nextColumn) {
      return card;
    }
    const position = positions.get(card.column) ?? 0;
    positions.set(card.column, position + 1);
    return { ...card, position };
  });
  return { nextCards, previousColumn, previousIndex };
}

export function moveBoardCard(
  boardId: string,
  cardId: string,
  column: ColumnType,
  position: number,
  before: string
) {
  return api.cards({ id: cardId }).patch(
    { column, position },
    {
      optimistic: (cache) =>
        cache.update(api.boards({ boardId }).get, (data) => ({
          ...data,
          cards: moveCard(data.cards, cardId, column, before)?.nextCards ?? data.cards,
        })),
    }
  );
}

export function deleteBoardCard(boardId: string, cardId: string) {
  return api.cards({ id: cardId }).delete(undefined, {
    optimistic: (cache) =>
      cache.update(api.boards({ boardId }).get, (data) => ({
        ...data,
        cards: data.cards.filter((card) => card.id !== cardId),
      })),
  });
}

export function createBoardCard(boardId: string, column: ColumnType, title: string) {
  const temporaryId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  return api.boards({ boardId }).cards.post(
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
              createdAt,
              description: "",
              id: temporaryId,
              position: data.cards.filter((card) => card.column === column).length,
              title,
            },
          ],
        })),
    }
  );
}

export function saveBoardCard(
  boardId: string,
  cardId: string,
  changes: { title: string; description: string }
) {
  return api.cards({ id: cardId }).patch(changes, {
    optimistic(cache) {
      cache.update(api.cards({ id: cardId }).get, (card) => ({ ...card, ...changes }));
      cache.update(api.boards({ boardId }).get, (data) => ({
        ...data,
        cards: data.cards.map((card) => (card.id === cardId ? { ...card, ...changes } : card)),
      }));
    },
  });
}
