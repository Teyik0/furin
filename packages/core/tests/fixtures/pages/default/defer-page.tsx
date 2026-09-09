import { defineRoute } from "@teyik0/furin";
import { defer } from "../../../../src/client";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(async () =>
    defer({
      stats: Promise.resolve(42),
      title: "deferred page",
    })
  )
  .page(({ data: { title } }) => <div data-testid="defer-page">{String(title)}</div>);
