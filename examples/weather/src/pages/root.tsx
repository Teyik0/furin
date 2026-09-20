import "./globals.css";
import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssg" })
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
