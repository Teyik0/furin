import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as rootRoute } from "../root";

export const querySchema = t.Object({
  city: t.Optional(t.String({ default: "Paris" })),
});

export const route = defineRoute()
  .config({
    layout: rootRoute,
    mode: "ssr",
    query: querySchema,
  })
  .layout(({ children }) => children);
