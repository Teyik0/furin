import { route } from "./route";

export default route.page({
  // Page loader only returns its own data.
  // layoutData arrives via the flat merge from the ancestor layout loader —
  // no need to re-forward it (would be undefined with parallel execution anyway).
  loader: async () => ({ pageData: "from-page" }),
  component: ({ layoutData, pageData }) => (
    <div data-layout={String(layoutData)} data-page={String(pageData)} data-testid="loader-page">
      Loader Page
    </div>
  ),
});
