import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/nested")
  .config({ mode: "ssg" })
  .page(() => <div data-testid="nested-page">Nested Page</div>);
