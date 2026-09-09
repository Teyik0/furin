import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "isr", revalidate: 60 })
  .loader(async () => ({ timestamp: Date.now() }))
  .page(({ data: { timestamp } }) => (
    <div data-testid="isr-page" data-timestamp={String(timestamp)}>
      ISR Page
    </div>
  ));
