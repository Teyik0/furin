import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";

export const route = defineRoute("/blog/[slug]")
  .config({
    mode: "ssg",
    params: t.Object({ slug: t.String() }),
  })
  .staticParams(() => [{ slug: "hello-world" }])
  .page(() => <article>Blog post page</article>);
