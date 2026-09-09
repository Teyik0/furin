import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .page(() => (
    <div data-testid="inline-layout">
      <div data-testid="inline-page">Inline Layout Page</div>
    </div>
  ));
