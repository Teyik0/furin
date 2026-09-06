import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr", params: t.Object({ "*": t.String() }) })
  .loader(({ params }) => ({ catchAllPath: params["*"] }))
  .page(({ data }) => data.catchAllPath);
