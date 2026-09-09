import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import "./globals.css";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="min-h-screen">{children}</div>
        <Scripts />
      </body>
    </html>
  ));
