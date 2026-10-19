import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/nested/deep")
  .config({ mode: "ssg" })
  .page(() => <div data-testid="deep-page">Deep Page</div>);
