import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

// Parent _route: declares parentFilter query with a default.
// mergeRouteSchemas in router.ts merges parent and child properties so parentFilter
// is preserved alongside any child-defined fields in the Elysia guard.
export const route = defineRoute("/schema-merge-parent/_route")
  .config({
    mode: "ssr",
    query: t.Object({
      parentFilter: t.Optional(t.String({ default: "parent-default" })),
    }),
  })
  .layout(({ children }) => children);
