import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const paramsSchema = t.Object({ id: t.String() });

export const route = defineRoute("/dynamic/[id]/_route")
  .config({ mode: "ssr", params: paramsSchema })
  .layout(({ children }) => children);
