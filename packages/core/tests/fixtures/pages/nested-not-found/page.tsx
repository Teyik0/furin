import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/")
  .config({ mode: "ssg" })
  .page(() => <div data-testid="home">Home</div>);
