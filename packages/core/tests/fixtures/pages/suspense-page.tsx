import { Suspense, use } from "react";
import { createRoute } from "../../../src/client";
import { route as rootRoute } from "./root";

const suspenseRoute = createRoute({
  parent: rootRoute,
  mode: "ssr",
});

// Resolves synchronously on the next microtask — enough to trigger a Suspense boundary.
const asyncContent = Promise.resolve("Suspense Content Loaded");

function AsyncChild() {
  const content = use(asyncContent);
  return <span data-testid="suspense-content">{content}</span>;
}

export default suspenseRoute.page({
  component: () => (
    <div data-testid="suspense-page">
      <Suspense fallback={<span data-testid="suspense-fallback">Loading...</span>}>
        <AsyncChild />
      </Suspense>
    </div>
  ),
});
