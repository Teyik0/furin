import { createRoute } from "@teyik0/furin/client";
import { t } from "elysia";
import { route as boardRoute } from "../../_route";

export const route = createRoute({
  parent: boardRoute,
  params: t.Object({
    boardId: t.String(),
    cardId: t.String(),
  }),
});
