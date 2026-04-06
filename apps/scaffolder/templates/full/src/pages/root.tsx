import { createRoute } from "@teyik0/furin/client";
import "./globals.css";

export const route = createRoute({
  layout: ({ children }) => (
    <main className="mx-auto flex min-h-screen max-w-5xl items-center px-6 py-16">{children}</main>
  ),
});
