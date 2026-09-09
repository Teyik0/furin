import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";

// Static sibling of `dynamic/[id]` — exercises route-specificity matching:
// `/dynamic/specific` must win over `/dynamic/:id` for this exact path.
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(() => ({ pageData: "from-static-specific" }))
  .page(({ data: { pageData } }) => <div data-testid="static-specific">{String(pageData)}</div>);
