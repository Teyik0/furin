import { furinSync } from "@teyik0/furin";
import { Elysia, t } from "elysia";
import { taskManagerSync } from "../../../sync";
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
      sync: { invalidate: { tags: ["cards"] } },
    },
    ({ params, body }) => createCard(params.boardId, body.title, body.column)
  )
  .post(
    "/cards/:id",
    {
      body: t.Object({
        description: t.Optional(t.String()),
        title: t.Optional(t.String()),
      }),
      sync: { invalidate: { tags: ["cards"] } },
    },
    ({ params, body, problem, redirect }) => {
      const existing = getCard(params.id);
      if (!existing) {
        return problem("Not Found", { detail: "Card not found" });
      }
      const card = updateCard(params.id, body);
      if (!card) {
        return problem("Not Found", { detail: "Card not found" });
      }
      return redirect(`/board/${card.boardId}`);
    }
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
      sync: { invalidate: { tags: ["cards"] } },
    },
    ({ params, body, problem }) => {
      const existing = getCard(params.id);
      if (!existing) {
        return problem("Not Found", { detail: "Card not found" });
      }
      const card = updateCard(params.id, body);
      if (!card) {
        return problem("Not Found", { detail: "Card not found" });
      }
      return card;
    }
  )
  .delete("/cards/:id", { sync: { invalidate: { tags: ["cards"] } } }, ({ params, problem }) => {
    const card = getCard(params.id);
    if (!card) {
      return problem("Not Found", { detail: "Card not found" });
    }
    const ok = deleteCard(params.id);
    if (!ok) {
      return problem("Not Found", { detail: "Card not found" });
    }
    return { ok: true };
  });
