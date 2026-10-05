import { defineRoute } from "@teyik0/furin";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(async ({ group }) => ({ group: await group }))
  .page(({ group }) => <p>{group}</p>);
