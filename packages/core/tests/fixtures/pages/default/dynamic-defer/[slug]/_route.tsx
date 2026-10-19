import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const paramsSchema = t.Object({ slug: t.String() });

export const route = defineRoute("/dynamic-defer/[slug]/_route")
  .config({ mode: "ssr", params: paramsSchema })
  .layout(({ children }) => children);
