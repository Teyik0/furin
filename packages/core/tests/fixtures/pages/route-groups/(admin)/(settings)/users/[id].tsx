import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute("/(admin)/(settings)/users/[id]")
  .config({ mode: "ssr", params: t.Object({ id: t.String() }) })
  .loader(async ({ group, params }) => ({ group: await group, id: params.id }))
  .page(({ group, id }) => (
    <p>
      {group}:{id}
    </p>
  ));
