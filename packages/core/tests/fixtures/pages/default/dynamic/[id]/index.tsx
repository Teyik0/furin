import { defineRoute } from "@teyik0/furin";
import { paramsSchema, route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr", params: paramsSchema })
  .loader(() => ({ pageData: "from-dynamic" }))
  .page(({ data: { pageData }, params }) => (
    <div data-id={String(params.id)} data-page={String(pageData)} data-testid="dynamic-page">
      Dynamic Page: {params.id}
    </div>
  ));
