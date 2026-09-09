import { defineRoute } from "@teyik0/furin";
import { defer } from "../../../../../../src/client";
import { paramsSchema, route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr", params: paramsSchema })
  .loader(({ params }) =>
    defer({
      post: Promise.resolve({ title: `Post for ${String(params.slug)}` }),
      slug: String(params.slug),
    })
  )
  .page(({ data: { slug } }) => <div data-testid="dynamic-defer-page">{slug}</div>);
