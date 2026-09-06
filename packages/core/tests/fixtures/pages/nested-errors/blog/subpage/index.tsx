import { defineRoute } from "@teyik0/furin";
import { route as parentRoute } from "../../root";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .page(() => <div data-testid="blog-subpage">Blog Subpage</div>);
