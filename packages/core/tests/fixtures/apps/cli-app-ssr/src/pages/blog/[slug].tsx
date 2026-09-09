import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { route as rootRoute } from "../root";

export const route = defineRoute()
  .config({
    layout: rootRoute,
    mode: "ssg",
    params: t.Object({ slug: t.String() }),
    staticParams: () => [{ slug: "hello-world" }],
  })
  .page(() => <article>Blog post page</article>);
