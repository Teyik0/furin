import { route } from "./_route";

export default route.page({
  component: ({ query }) => (
    <div data-city={String((query as { city?: string }).city)} data-testid="query-default-page">
      City: {String((query as { city?: string }).city)}
    </div>
  ),
});
