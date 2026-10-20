import { furinSync } from "@teyik0/furin";
import { Elysia, t } from "elysia";
import { taskManagerSync } from "../../../sync";
import { getBoard } from "../boards/service";
import { columnType } from "../shared";
import { createCard, deleteCard, getCard, updateCard } from "./service";

export const cardPlugin = new Elysia()
  .use(furinSync(taskManagerSync))
  .get("/cards/:id", ({ params, problem }) => {
    const card = getCard(params.id);
    if (!card) {
      return problem("Not Found", { detail: "Card not found" });
    }
    return card;
  })
  .post(
    "/boards/:boardId/cards",
    {
      body: t.Object({
        column: columnType,
        title: t.String({ minLength: 1 }),
      }),
    },
    ({ params, body, problem, mutation, invalidate }) =>
      mutation((tx) => {
        if (!getBoard(params.boardId, tx)) {
          return problem("Not Found", { detail: "Board not found" });
        }
        invalidate("/api/boards/:boardId", { boardId: params.boardId });
        invalidate("/api/boards/:boardId/stats", { boardId: params.boardId });
        return createCard(tx, params.boardId, body.title, body.column);
      })
  )
  .guard(
    // Each mutation refreshes GET /api/cards/:id by self-invalidation, and its board views.
    { params: t.Object({ id: t.String() }) },
    (app) =>
      app
        .post(
          "/cards/:id",
          {
            body: t.Object({
              description: t.Optional(t.String()),
              title: t.Optional(t.String()),
            }),
          },
          ({ params, body, problem, redirect, mutation, invalidate }) =>
            mutation((tx) => {
              const existing = getCard(params.id, tx);
              if (!existing) {
                return problem("Not Found", { detail: "Card not found" });
              }
              const card = updateCard(tx, params.id, body);
              if (!card) {
                return problem("Not Found", { detail: "Card not found" });
              }
              invalidate("/api/boards/:boardId", { boardId: card.boardId });
              invalidate("/api/boards/:boardId/stats", { boardId: card.boardId });
              return redirect(`/board/${card.boardId}`);
            })
        )
        .patch(
          "/cards/:id",
          {
            body: t.Object({
              column: t.Optional(columnType),
              description: t.Optional(t.String()),
              position: t.Optional(t.Number()),
              title: t.Optional(t.String()),
            }),
          },
          ({ params, body, problem, mutation, invalidate }) =>
            mutation((tx) => {
              const existing = getCard(params.id, tx);
              if (!existing) {
                return problem("Not Found", { detail: "Card not found" });
              }
              const card = updateCard(tx, params.id, body);
              if (!card) {
                return problem("Not Found", { detail: "Card not found" });
              }
              invalidate("/api/boards/:boardId", { boardId: card.boardId });
              invalidate("/api/boards/:boardId/stats", { boardId: card.boardId });
              return card;
            })
        )
        .delete("/cards/:id", ({ params, problem, mutation, invalidate }) =>
          mutation((tx) => {
            const card = getCard(params.id, tx);
            if (!card) {
              return problem("Not Found", { detail: "Card not found" });
            }
            const ok = deleteCard(tx, params.id);
            if (!ok) {
              return problem("Not Found", { detail: "Card not found" });
            }
            invalidate("/api/boards/:boardId", { boardId: card.boardId });
            invalidate("/api/boards/:boardId/stats", { boardId: card.boardId });
            return { ok: true };
          })
        )
  );
