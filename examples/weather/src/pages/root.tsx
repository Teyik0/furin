import { t } from "elysia";
import "./globals.css";
import { createRoute } from "@teyik0/furin/client";

export const route = createRoute({
  query: t.Object({
    city: t.Optional(t.String({ default: "Paris" })),
  }),
  layout: ({ children }) => (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-12">{children}</main>
  ),
});
