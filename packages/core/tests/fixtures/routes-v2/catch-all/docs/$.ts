import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute("/docs/$")
  .config({ mode: "ssr", params: t.Object({ _splat: t.String() }) })
  .loader(({ params }) => ({ catchAllPath: params._splat }))
  .page(({ catchAllPath }) => catchAllPath);
