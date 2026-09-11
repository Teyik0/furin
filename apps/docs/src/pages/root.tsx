import "./globals.css";
import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import { RootLayout } from "@/components/root-layout";

const THEME_INIT_SCRIPT =
  'try{var t=localStorage.getItem("furin-theme"),r=document.documentElement;r.classList.remove("light","dark");r.classList.add(t==="light"?"light":"dark")}catch(e){}';

export const route = defineRootRoute()
  .config({ mode: "ssg" })
  .layout(({ children }) => (
    <html className="dark" lang="en" suppressHydrationWarning>
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static application-owned theme bootstrap.
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
        />
        <HeadContent />
      </head>
      <body>
        <RootLayout>{children}</RootLayout>
        <Scripts />
      </body>
    </html>
  ));
