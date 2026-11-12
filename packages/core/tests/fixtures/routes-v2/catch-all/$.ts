import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute("/$")
  .config({ mode: "ssr", params: t.Object({ _splat: t.String() }) })
  .loader(({ params }) => ({ rootCatchAllPath: params._splat }))
  .page(({ rootCatchAllPath }) => rootCatchAllPath);
