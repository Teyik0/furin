import { t } from "elysia";
import "./globals.css";
import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({
    mode: "ssr",
    query: t.Object({
      city: t.String({ default: "Paris" }),
    }),
  })
  .layout(({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-12">{children}</main>
        <Scripts />
      </body>
    </html>
  ));
