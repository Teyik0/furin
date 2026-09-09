import { defineRoute } from "@teyik0/furin";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .page(() => <div data-testid="nested-page">Nested Page</div>);
