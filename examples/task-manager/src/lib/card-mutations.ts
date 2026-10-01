import type { ColumnType, KanbanCard } from "@/components/ui/kanban";

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
