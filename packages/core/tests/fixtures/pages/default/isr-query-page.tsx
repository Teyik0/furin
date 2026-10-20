import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute("/isr-query-page")
  .config({
    mode: "isr",
    query: t.Object({ tenant: t.Optional(t.String()) }),
    revalidate: 60,
  })
  .loader(({ query }) => ({
    tenant: query.tenant ?? "",
    timestamp: Date.now(),
  }))
  .page(({ tenant, timestamp }) => (
    <div data-tenant={tenant} data-testid="isr-query-page" data-timestamp={String(timestamp)}>
      {tenant}
    </div>
  ));
