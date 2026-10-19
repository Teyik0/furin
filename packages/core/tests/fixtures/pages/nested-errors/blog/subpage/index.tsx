import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/blog/subpage")
  .config({ mode: "ssg" })
  .page(() => <div data-testid="blog-subpage">Blog Subpage</div>);
