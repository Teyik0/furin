import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const querySchema = t.Object({
  city: t.Optional(t.String({ default: "Paris" })),
});

export const route = defineRoute("/query-default/_route")
  .config({
    mode: "ssr",
    query: querySchema,
  })
  .layout(({ children }) => children);
