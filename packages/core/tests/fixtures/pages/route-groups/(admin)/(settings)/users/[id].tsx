import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as parentRoute } from "../_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr", params: t.Object({ id: t.String() }) })
  .loader(async ({ group, params }) => ({ group: await group, id: params.id }))
  .page(({ group, id }) => (
    <p>
      {group}:{id}
    </p>
  ));
