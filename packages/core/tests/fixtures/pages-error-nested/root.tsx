import { createRoute } from "../../../src/client";

export const route = createRoute({
  layout: ({ children }) => <div data-testid="root-layout">{children}</div>,
});
