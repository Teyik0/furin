import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/inline-layout")
  .config({ mode: "ssg" })
  .page(() => (
    <div data-testid="inline-layout">
      <div data-testid="inline-page">Inline Layout Page</div>
    </div>
  ));
