import { defineRoute, notFound } from "@teyik0/furin";
import { t } from "elysia";
import { getBoard } from "@/api/modules/boards/service";
import { getCard } from "@/api/modules/cards/service";
import { CardDetailPage } from "@/components/card-detail-page";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({
    layout: parentRoute,
    mode: "ssr",
    params: t.Object({ boardId: t.String(), cardId: t.String() }),
    tags: ["cards"],
  })
  .loader(({ params }) => {
    const board = getBoard(params.boardId);
    const card = getCard(params.cardId);

    if (!board) {
      notFound({ message: "Board not found" });
    }
    if (!card) {
      notFound({ message: "Card not found" });
    }
    if (card.boardId !== params.boardId) {
      notFound({ message: "Card not found" });
    }

    const renderedAt = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const formattedCreatedAt = new Date(card.createdAt).toLocaleDateString("en-US", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });

    return {
      boardName: board.name,
      card,
      formattedCreatedAt,
      renderedAt,
    };
  })
  .head(({ data: { card, boardName } }) => ({
    meta: [{ title: `${card.title} | ${boardName} | Task Manager` }],
  }))
  .page(({ data: { card, boardName, renderedAt, formattedCreatedAt }, params }) => (
    <CardDetailPage
      boardName={boardName}
      card={card}
      formattedCreatedAt={formattedCreatedAt}
      params={params}
      renderedAt={renderedAt}
    />
  ));
