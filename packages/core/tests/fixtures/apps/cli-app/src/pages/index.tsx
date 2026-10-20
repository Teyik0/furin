import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/")
  .config({ mode: "ssg" })
  .page(() => <main>Home page</main>);
