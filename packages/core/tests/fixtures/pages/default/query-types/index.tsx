import { defineRoute } from "@teyik0/furin";
import { route as parentRoute, querySchema } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr", query: querySchema })
  .loader(({ query }) => ({
    queryFromLoader: query,
  }))
  .page(({ query }) => <div data-testid="query-types-page">{JSON.stringify(query)}</div>);
