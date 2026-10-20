import { expect, test } from "bun:test";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { getFreePort } from "../support/hmr.ts";
import { waitForHttp } from "../support/http.ts";
import { runCli, startProcess } from "../support/process.ts";

const browserTest = process.env.FURIN_WEBVIEW_TESTS === "1" ? test : test.skip;
const RESPONSIVE_PRELOAD = /<link[^>]*imagesrcset=/i;

browserTest.each(["development", "production"])(
  "RSC navigation preserves responsive images without runtime errors (%s)",
  async (mode) => {
    const app = createTmpApp("cli-app");
    let server: ReturnType<typeof startProcess> | undefined;
    let view: InstanceType<typeof Bun.WebView> | undefined;
    try {
      writeAppFile(app.path, "src/style.css", "body { font-family: sans-serif; }");
      writeAppFile(
        app.path,
        "src/pages/root.tsx",
        `
import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import "../style.css";
export const route = defineRootRoute().config({ mode: "ssr" })
  .layout(({ children }) => <html lang="en"><head><HeadContent /></head>
    <body>{children}<Scripts /></body></html>);
`
      );
      writeAppFile(
        app.path,
        "src/pages/index.tsx",
        `
import { defineRoute } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { useEffect } from "react";
export const route = defineRoute("/").config({ mode: "ssr" }).page(() => {
  useEffect(() => { document.documentElement.dataset.ready = "true"; }, []);
  return <Link data-testid="image-link" to="/image">Image</Link>;
});
`
      );
      writeAppFile(
        app.path,
        "src/pages/image.tsx",
        `
import { defineRoute } from "@teyik0/furin";
import { renderServerComponent } from "@teyik0/furin/rsc";
export const route = defineRoute("/image").config({ mode: "ssr" })
  .loader(async () => ({ hero: await renderServerComponent(
    <img alt="Hero" src="/public/hero.svg" srcSet="/public/hero.svg 480w, /public/large.svg 960w"
      sizes="100vw" fetchPriority="high" width={480} height={240} />
  ) }))
  .page(({ hero }) => <main data-testid="image-page">{hero}</main>);
`
      );
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="orange"/></svg>';
      writeAppFile(app.path, "public/hero.svg", svg);
      writeAppFile(app.path, "public/large.svg", svg);
      if (mode === "production") {
        const build = await runCli(["build", "--target", "bun"], { cwd: app.path });
        expect(build.exitCode, build.stderr).toBe(0);
      }
      const port = await getFreePort();
      const origin = `http://127.0.0.1:${port}`;
      server = startProcess(
        mode === "development"
          ? [process.execPath, "--hot", "src/server.ts"]
          : [process.execPath, ".furin/build/bun/server.js"],
        {
          cwd: app.path,
          env: { NODE_ENV: mode, PORT: String(port) },
        }
      );
      await waitForHttp(origin, { timeoutMs: 15_000 });
      const imageHtml = await (await fetch(`${origin}/image`)).text();
      expect(imageHtml).toMatch(RESPONSIVE_PRELOAD);
      view = new Bun.WebView({ backend: { type: "chrome", url: false } });
      await view.navigate(origin);
      await view.evaluate(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(poll); reject(new Error("Hydration timed out")); }, 10000);
      const poll = setInterval(() => {
        if (document.documentElement.dataset.ready === "true") {
          clearTimeout(timeout); clearInterval(poll); resolve(true);
        }
      }, 20);
    })`);
      await view.evaluate(`(() => { window.__rscErrors = [];
      window.__rscDocument = "preserved";
      window.addEventListener("error", event => window.__rscErrors.push(event.message));
      document.querySelector('[data-testid="image-link"]').click(); })()`);
      await view.evaluate(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(poll); reject(new Error("Navigation timed out")); }, 10000);
      const poll = setInterval(() => {
        if (location.pathname === "/image" && document.querySelector('[data-testid="image-page"] img')) {
          clearTimeout(timeout); clearInterval(poll); resolve(true);
        }
      }, 20);
    })`);
      expect(await view.evaluate("window.__rscDocument")).toBe("preserved");
      expect(await view.evaluate("window.__rscErrors")).toEqual([]);
      expect(
        await view.evaluate(
          "document.querySelectorAll('head link[rel=preload][as=image][imagesrcset]').length"
        )
      ).toBe(mode === "production" ? 1 : 0);
      expect(
        await view.evaluate(
          "document.querySelector('[data-testid=\"image-page\"] img').getAttribute('srcset')"
        )
      ).toBe("/public/hero.svg 480w, /public/large.svg 960w");
    } finally {
      view?.close();
      server?.kill();
      await server?.exitCode;
      app.cleanup();
    }
  },
  30_000
);
