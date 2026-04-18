import { t } from "elysia";
import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "../root";

// Parent _route: declares parentFilter query with a default.
// mergeRouteSchemas in router.ts merges parent and child properties so parentFilter
// is preserved alongside any child-defined fields in the Elysia guard.
export const route = createRoute({
  parent: rootRoute,
  query: t.Object({
    parentFilter: t.Optional(t.String({ default: "parent-default" })),
  }),
});
