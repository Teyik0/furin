import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/skip-layout")
  .config({ mode: "ssg" })
  .page(() => <div data-testid="skip-page">Skip Layout Page (uses root directly)</div>);
