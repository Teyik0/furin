import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/sync-loader")
  .config({ mode: "ssr" })
  .loader(() => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < 8) {
      // Deliberate synchronous work verifies that DevTools times loader invocation.
    }
    return { completed: true };
  })
  .page(() => <div>sync loader</div>);
