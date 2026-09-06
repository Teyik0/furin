import { defineRoute } from "@teyik0/furin";
import { home } from "../shared.ts";
import { route as rootRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .loader(async ({ root }) => ({ home, root: await root }))
  .page(({ data }) => String(data.home));
