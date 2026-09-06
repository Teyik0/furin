import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

/**
 * SSG fixture WITH a loader — used by the dev SSG loader-cache tests.
 * The loader captures `Date.now()` so a cache hit (same timestamp) vs
 * miss (advanced timestamp) is directly observable in the rendered HTML.
 */
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .loader(() => Promise.resolve({ timestamp: Date.now() }))
  .page(({ data: { timestamp } }) => (
    <div data-testid="ssg-loader-page" data-timestamp={String(timestamp)}>
      SSG Loader Page
    </div>
  ));
