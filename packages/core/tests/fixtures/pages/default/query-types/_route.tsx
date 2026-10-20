import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const querySchema = t.Object({
  active: t.Boolean(),
  filter: t.Optional(t.Object({ category: t.String() })),
  page: t.Number(),
  tags: t.Optional(t.Array(t.String())),
});

export const route = defineRoute("/query-types/_route")
  .config({
    mode: "ssr",
    query: querySchema,
  })
  .layout(({ children }) => children);
