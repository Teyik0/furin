import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .loader(() => ({}))
  .head(() => ({
    links: [{ href: "/test.css", rel: "stylesheet" }],
    meta: [{ title: "SSG Test Page" }, { content: "Test description", name: "description" }],
  }))
  .page(() => <div data-testid="ssg-page">SSG Page</div>);
