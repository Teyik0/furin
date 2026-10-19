import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/with-loader")
  .config({ mode: "ssr" })
  .loader(async () => ({ pageData: "from-page" }))
  .page(({ layoutData, pageData }) => (
    <div data-layout={String(layoutData)} data-page={String(pageData)} data-testid="loader-page">
      Loader Page
    </div>
  ));
