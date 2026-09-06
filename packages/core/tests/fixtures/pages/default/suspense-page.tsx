import { defineRoute } from "@teyik0/furin";
import { Suspense, use } from "react";
import { route as rootRoute } from "./root";

// Resolves synchronously on the next microtask — enough to trigger a Suspense boundary.
const asyncContent = Promise.resolve("Suspense Content Loaded");

function AsyncChild() {
  const content = use(asyncContent);
  return <span data-testid="suspense-content">{content}</span>;
}

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .page(() => (
    <div data-testid="suspense-page">
      <Suspense fallback={<span data-testid="suspense-fallback">Loading…</span>}>
        <AsyncChild />
      </Suspense>
    </div>
  ));
