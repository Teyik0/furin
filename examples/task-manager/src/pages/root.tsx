import { createRoute } from "@teyik0/furin/client";
import "./globals.css";

export const route = createRoute({
  layout: ({ children }) => <div className="min-h-screen">{children}</div>,
});
