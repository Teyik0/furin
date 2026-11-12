import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/board/$boardId/card")
  .config({
    mode: "ssr",
    tags: ["cards"],
  })
  .layout(({ children }) => children);
