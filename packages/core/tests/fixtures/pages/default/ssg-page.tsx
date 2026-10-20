import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/ssg-page")
  .config({ mode: "ssg" })
  .loader(() => ({}))
  .head(() => ({
    links: [{ href: "/test.css", rel: "stylesheet" }],
    meta: [{ title: "SSG Test Page" }, { content: "Test description", name: "description" }],
  }))
  .page(() => <div data-testid="ssg-page">SSG Page</div>);
