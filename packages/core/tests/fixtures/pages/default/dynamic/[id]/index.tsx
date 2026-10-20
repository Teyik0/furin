import { defineRoute } from "@teyik0/furin";
import { paramsSchema } from "./_route";

export const route = defineRoute("/dynamic/[id]")
  .config({ mode: "ssr", params: paramsSchema })
  .loader(() => ({ pageData: "from-dynamic" }))
  .page(({ pageData, params }) => (
    <div data-id={String(params.id)} data-page={String(pageData)} data-testid="dynamic-page">
      Dynamic Page: {params.id}
    </div>
  ));
