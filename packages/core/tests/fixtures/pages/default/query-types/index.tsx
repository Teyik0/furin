import { defineRoute } from "@teyik0/furin";
import { querySchema } from "./_route";

export const route = defineRoute("/query-types")
  .config({ mode: "ssr", query: querySchema })
  .loader(({ query }) => ({
    queryFromLoader: query,
  }))
  .page(({ query }) => <div data-testid="query-types-page">{JSON.stringify(query)}</div>);
