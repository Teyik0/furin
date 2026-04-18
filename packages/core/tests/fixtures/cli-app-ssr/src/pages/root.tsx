import { createRoute } from "@teyik0/furin/client";

export const route = createRoute({
  layout: ({ children }) => <div data-testid="root-layout">{children}</div>,
});
