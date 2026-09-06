import "./globals.css";
import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import { RootLayout } from "@/components/root-layout";

export const route = defineRootRoute()
  .config({ mode: "ssg" })
  .layout(({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <RootLayout>{children}</RootLayout>
        <Scripts />
      </body>
    </html>
  ));
