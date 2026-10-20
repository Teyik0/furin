import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/board/[boardId]/card/_route")
  .config({
    mode: "ssr",
    tags: ["cards"],
  })
  .layout(({ children }) => children);
