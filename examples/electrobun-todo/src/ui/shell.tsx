import { HeadContent, Scripts } from "@teyik0/furin/client";
import type { ReactNode } from "react";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <head>
        <HeadContent />
      </head>
      <body style={{ background: "#f6f7f7", color: "#202c29", margin: 0 }}>
        <main>{children}</main>
        <Scripts />
      </body>
    </html>
  );
}
