import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/blog")
  .config({ mode: "ssg" })
  .page(() => <div data-testid="blog-index">Blog</div>);
