import { t } from "elysia";
import { createRoute } from "../../../../../src/client";
import { route as parentRoute } from "../_route";

// Child _route: declares childFilter query with a default.
// mergeRouteSchemas in router.ts merges both schemas so parentFilter and childFilter
// are both present in the Elysia guard — neither is dropped.
export const route = createRoute({
  parent: parentRoute,
  query: t.Object({
    childFilter: t.Optional(t.String({ default: "child-default" })),
  }),
});
