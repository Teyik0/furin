import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(() => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 8) {
      // Deliberate synchronous work verifies that DevTools times loader invocation.
    }
    return { completed: true };
  })
  .page(() => <div>sync loader</div>);
