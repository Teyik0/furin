import { defineRoute } from "@teyik0/furin";
import { querySchema } from "./_route";

export const route = defineRoute("/query-default")
  .config({ mode: "ssr", query: querySchema })
  .page(({ query }) => (
    <div data-city={String((query as { city?: string }).city)} data-testid="query-default-page">
      City: {String((query as { city?: string }).city)}
    </div>
  ));
