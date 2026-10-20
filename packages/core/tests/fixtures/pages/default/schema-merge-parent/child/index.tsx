import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute("/schema-merge-parent/child")
  .config({
    mode: "ssr",
    query: t.Object({
      childFilter: t.Optional(t.String({ default: "child-default" })),
      parentFilter: t.Optional(t.String({ default: "parent-default" })),
    }),
  })
  .page(({ query }) => (
    <div data-testid="schema-merge-page">
      <span data-testid="parent-filter">
        {String((query as { parentFilter?: string }).parentFilter)}
      </span>
      <span data-testid="child-filter">
        {String((query as { childFilter?: string }).childFilter)}
      </span>
    </div>
  ));
