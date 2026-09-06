import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as boardRoute } from "../../_route";

export const route = defineRoute()
  .config({
    layout: boardRoute,
    mode: "ssr",
    params: t.Object({
      boardId: t.String(),
      cardId: t.String(),
    }),
    tags: ["cards"],
  })
  .layout(({ children }) => children);
