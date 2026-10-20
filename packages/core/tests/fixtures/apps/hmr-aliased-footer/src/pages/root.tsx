import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import { PublicFooter } from "@/components/public-footer";

export const route = defineRootRoute()
  .config({ mode: "isr", revalidate: 300 })
  .layout(({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <PublicFooter />
        <Scripts />
      </body>
    </html>
  ));
