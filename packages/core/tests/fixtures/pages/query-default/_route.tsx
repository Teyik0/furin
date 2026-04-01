import { t } from "elysia";
import { createRoute } from "../../../../src/client";
import { route as rootRoute } from "../root";

export const route = createRoute({
  parent: rootRoute,
  query: t.Object({
    city: t.Optional(t.String({ default: "Paris" })),
  }),
});
