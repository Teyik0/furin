import { furinSync } from "@teyik0/furin";
import { type Elysia, t } from "elysia";
import { taskManagerSync } from "../../../sync";
import { columnType } from "../shared";
import { createCard, deleteCard, getCard, updateCard } from "./service";

export const cardPlugin = (app: Elysia) =>
  app
    .use(furinSync(taskManagerSync))
    .get("/cards/:id", ({ params, status }) => {
      const card = getCard(params.id);
      if (!card) {
        return status("Not Found", "Not found");
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
      ({ params, body, status, redirect }) => {
        const existing = getCard(params.id);
        if (!existing) {
          return status("Not Found", "Not found");
        }
        const card = updateCard(params.id, body);
        if (!card) {
          return status("Not Found", "Not found");
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
      ({ params, body, status }) => {
        const existing = getCard(params.id);
        if (!existing) {
          return status("Not Found", "Not found");
        }
        const card = updateCard(params.id, body);
        if (!card) {
          return status("Not Found", "Not found");
        }
        return card;
      }
    )
    .delete("/cards/:id", { sync: { invalidate: { tags: ["cards"] } } }, ({ params, status }) => {
      const card = getCard(params.id);
      if (!card) {
        return status("Not Found", "Not found");
      }
      const ok = deleteCard(params.id);
      if (!ok) {
        return status("Not Found", "Not found");
      }
      return { ok: true };
    });
