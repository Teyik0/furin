import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({
    layout: rootRoute,
    mode: "isr",
    query: t.Object({ tenant: t.Optional(t.String()) }),
    revalidate: 60,
  })
  .loader(({ query }) => ({
    tenant: query.tenant ?? "",
    timestamp: Date.now(),
  }))
  .page(({ data: { tenant, timestamp } }) => (
    <div data-tenant={tenant} data-testid="isr-query-page" data-timestamp={String(timestamp)}>
      {tenant}
    </div>
  ));
