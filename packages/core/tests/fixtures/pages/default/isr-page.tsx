import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/isr-page")
  .config({ mode: "isr", revalidate: 60 })
  .loader(async () => ({ timestamp: Date.now() }))
  .page(({ timestamp }) => (
    <div data-testid="isr-page" data-timestamp={String(timestamp)}>
      ISR Page
    </div>
  ));
