import { defineRoute } from "@teyik0/furin";
import { defer } from "../../../../src/client";

export const route = defineRoute("/defer-page")
  .config({ mode: "ssr" })
  .loader(async () =>
    defer({
      stats: Promise.resolve(42),
      title: "deferred page",
    })
  )
  .page(({ title }) => <div data-testid="defer-page">{String(title)}</div>);
