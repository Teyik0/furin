import { defineRoute } from "@teyik0/furin";
import { defer } from "../../../../../../src/client";
import { paramsSchema } from "./_route";

export const route = defineRoute("/dynamic-defer/[slug]")
  .config({ mode: "ssr", params: paramsSchema })
  .loader(({ params }) =>
    defer({
      post: Promise.resolve({ title: `Post for ${String(params.slug)}` }),
      slug: String(params.slug),
    })
  )
  .page(({ slug }) => <div data-testid="dynamic-defer-page">{slug}</div>);
