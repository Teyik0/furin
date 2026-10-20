import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="fr">
      <head>
        <HeadContent />
      </head>
      <body style={{ background: "#f6f7f7", color: "#202c29", margin: 0 }}>
        <main>{children}</main>
        <Scripts />
      </body>
    </html>
  ));
