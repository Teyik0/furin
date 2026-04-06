import { t } from "elysia";

export const columnType = t.Union([
  t.Literal("backlog"),
  t.Literal("todo"),
  t.Literal("doing"),
  t.Literal("done"),
]);
