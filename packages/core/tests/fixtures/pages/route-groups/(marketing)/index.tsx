import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/(marketing)")
  .config({ mode: "ssr" })
  .loader(async ({ group }) => ({ group: await group }))
  .page(({ group }) => <p>{group}</p>);
