import { furinSync } from "@teyik0/furin";
import type { SyncInvalidationInput } from "@teyik0/furin/sync";
import { Elysia, t } from "elysia";
import { taskManagerSync } from "../../../sync";
import { getBoard } from "../boards/service";
import { columnType } from "../shared";
import { createCard, deleteCard, getCard, updateCard } from "./service";

function cardInvalidations(id: string | undefined, responseValue: unknown): SyncInvalidationInput {
  let boardId = id ? getCard(id)?.boardId : undefined;
  if (
    responseValue &&
    typeof responseValue === "object" &&
    "boardId" in responseValue &&
    typeof responseValue.boardId === "string"
  ) {
    ({ boardId } = responseValue);
  }
  return [
    ...(boardId ? [{ id: "board" as const, scope: { boardId } }] : []),
    ...(id ? [{ id: "card" as const, scope: { id } }] : []),
  ];
}

export const cardPlugin = new Elysia()
  .use(furinSync(taskManagerSync))
  .get(
    "/cards/:id",
    { sync: { id: "card", scope: ({ params }) => ({ id: params.id }) } },
    ({ params, problem }) => {
      const card = getCard(params.id);
      if (!card) {
        return problem("Not Found", { detail: "Card not found" });
      }
      return card;
    }
  )
  .post(
    "/boards/:boardId/cards",
    {
      body: t.Object({
        column: columnType,
        title: t.String({ minLength: 1 }),
      }),
      sync: { invalidate: ({ responseValue }) => cardInvalidations(undefined, responseValue) },
    },
    ({ params, body, problem, mutation }) =>
      mutation((tx) => {
        if (!getBoard(params.boardId, tx)) {
          return problem("Not Found", { detail: "Board not found" });
        }
        return createCard(tx, params.boardId, body.title, body.column);
      })
  )
  .post(
    "/cards/:id",
    {
      body: t.Object({
        description: t.Optional(t.String()),
        title: t.Optional(t.String()),
      }),
      sync: {
        invalidate: ({ params, responseValue }) => cardInvalidations(params.id, responseValue),
      },
    },
    ({ params, body, problem, redirect, mutation }) =>
      mutation((tx) => {
        const existing = getCard(params.id, tx);
        if (!existing) {
          return problem("Not Found", { detail: "Card not found" });
        }
        const card = updateCard(tx, params.id, body);
        if (!card) {
          return problem("Not Found", { detail: "Card not found" });
        }
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
      sync: {
        invalidate: ({ params, responseValue }) => cardInvalidations(params.id, responseValue),
      },
    },
    ({ params, body, problem, mutation }) =>
      mutation((tx) => {
        const existing = getCard(params.id, tx);
        if (!existing) {
          return problem("Not Found", { detail: "Card not found" });
        }
        const card = updateCard(tx, params.id, body);
        if (!card) {
          return problem("Not Found", { detail: "Card not found" });
        }
        return card;
      })
  )
  .delete(
    "/cards/:id",
    {
      sync: {
        invalidate: ({ params, responseValue }) => cardInvalidations(params.id, responseValue),
      },
    },
    ({ params, problem, mutation }) =>
      mutation((tx) => {
        const card = getCard(params.id, tx);
        if (!card) {
          return problem("Not Found", { detail: "Card not found" });
        }
        const ok = deleteCard(tx, params.id);
        if (!ok) {
          return problem("Not Found", { detail: "Card not found" });
        }
        return { ok: true, boardId: card.boardId };
      })
  );
