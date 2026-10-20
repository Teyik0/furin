import { defineRoute } from "@teyik0/furin";

// Static sibling of `dynamic/[id]` — exercises route-specificity matching:
// `/dynamic/specific` must win over `/dynamic/:id` for this exact path.
export const route = defineRoute("/dynamic/specific")
  .config({ mode: "ssr" })
  .loader(() => ({ pageData: "from-static-specific" }))
  .page(({ pageData }) => <div data-testid="static-specific">{String(pageData)}</div>);
