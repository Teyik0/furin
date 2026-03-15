import { createRoute } from "furinjs/client";

export const route = createRoute({
  layout: ({ children }) => <div data-testid="root-layout">{children}</div>,
});
