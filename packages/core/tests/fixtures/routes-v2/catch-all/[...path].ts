import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute("/")
  .config({ mode: "ssr", params: t.Object({ "*": t.String() }) })
  .loader(({ params }) => ({ rootCatchAllPath: params["*"] }))
  .page(({ rootCatchAllPath }) => rootCatchAllPath);
