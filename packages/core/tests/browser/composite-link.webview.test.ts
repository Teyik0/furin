// biome-ignore-all lint/performance/noAwaitInLoops: browser assertions poll observable navigation and HMR state
import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getFreePort } from "../support/hmr.ts";
import { waitForHttp } from "../support/http.ts";
import { startProcess } from "../support/process.ts";

const browserTest = process.env.FURIN_WEBVIEW_TESTS === "1" ? test : test.skip;
const coreDirectory = resolve(import.meta.dir, "../..");

interface NavigationSnapshot {
  count: string | null;
  href: string | null;
  marker?: string;
}

const headerSource = `"use client";
import { useEffect, useRef, useState } from "react";
import { Link } from "@teyik0/furin/link";
export function Header() {
  const [count, setCount] = useState(0);
  const counter = useRef<HTMLButtonElement>(null);
  useEffect(() => { counter.current?.setAttribute("data-hydrated", "true"); }, []);
  return <nav>
    <Link data-testid="classic-other" to="/other">Classic other</Link>
    <Link data-testid="classic-home" to="/">Classic home</Link>
    <button ref={counter} data-testid="counter" onClick={() => setCount(count + 1)}>Count {count}</button>
    <span data-testid="header-version">header-v1</span>
  </nav>;
}`;

const rootSource = `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";
import type { ReactNode } from "react";
import { Header } from "../header";
export const route = defineRootRoute().config({ mode: "ssr" })
  .loader(async () => ({ header: await createCompositeComponent<{ children: ReactNode }>(
    ({ children }) => <header>
      <Link data-testid="composite-other" to="/other">Composite other</Link>
      <Link data-testid="composite-home" to="/">Composite home</Link>
      <span data-testid="composite-version">composite-v1</span>
      {children}
    </header>
  ) }))
  .layout(({ children, header }) => <html lang="en">
    <head><HeadContent /></head>
    <body><CompositeComponent src={header}><Header /></CompositeComponent>{children}<Scripts /></body>
  </html>);`;

async function createConsumerApp(): Promise<string> {
  // A copied package outside the workspace cannot inherit the source aliases
  // that hide conditional-export differences in monorepo fixtures.
  const directory = mkdtempSync(join(tmpdir(), "furin-composite-navigation-"));
  const modules = join(directory, "node_modules");
  mkdirSync(modules);
  const dependencies = join(coreDirectory, "node_modules");
  for (const entry of readdirSync(dependencies)) {
    if (entry.startsWith(".")) {
      continue;
    }
    const names = entry.startsWith("@")
      ? readdirSync(join(dependencies, entry)).map((name) => `${entry}/${name}`)
      : [entry];
    for (const name of names) {
      if (name === "@teyik0/furin") {
        continue;
      }
      const target = join(modules, name);
      mkdirSync(join(target, ".."), { recursive: true });
      symlinkSync(realpathSync(join(dependencies, name)), target, "dir");
    }
  }
  const packageDirectory = join(modules, "@teyik0/furin");
  mkdirSync(packageDirectory, { recursive: true });
  for (const name of ["package.json", "src", "dist"]) {
    cpSync(join(coreDirectory, name), join(packageDirectory, name), { recursive: true });
  }
  const files: { [path: string]: string } = {
    "package.json": JSON.stringify({ name: "composite-navigation-consumer", type: "module" }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
    "bunfig.toml": '[serve.static]\nplugins = ["@teyik0/furin/strip-plugin"]\n',
    "furin.config.ts": `import { defineConfig } from "@teyik0/furin/config";
export default defineConfig({
  serverEntry: "src/server.ts",
  apps: [{ pagesDir: "src/pages" }, { pagesDir: "src/admin", prefix: "/admin" }],
});`,
    "src/header.tsx": headerSource,
    "src/server.ts": `import { Elysia } from "elysia";
import { furin } from "@teyik0/furin";
const app = new Elysia()
  .use(await furin({ pagesDir: import.meta.dir + "/pages" }))
  .use(await furin({ pagesDir: import.meta.dir + "/admin", prefix: "/admin" }));
if (import.meta.main) app.listen(Number(process.env.PORT));
export default app;`,
  };
  for (const section of ["pages", "admin"]) {
    files[`src/${section}/root.tsx`] = rootSource;
    for (const page of ["index", "other"]) {
      files[`src/${section}/${page}.tsx`] = `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute().config({ layout: rootRoute, mode: "ssr" })
  .page(() => <main data-page="${page === "index" ? "home" : "other"}">${page}</main>);`;
    }
  }
  for (const [path, contents] of Object.entries(files)) {
    await Bun.write(join(directory, path), contents);
  }
  return directory;
}

async function waitFor(view: InstanceType<typeof Bun.WebView>, expression: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await view.evaluate(expression)) {
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

browserTest.each([
  { mode: "development", prefix: "" },
  { mode: "development", prefix: "/admin" },
  { mode: "production", prefix: "" },
  { mode: "production", prefix: "/admin" },
])(
  "packaged composite and classic Links preserve SPA navigation ($mode, prefix '$prefix')",
  async ({ mode, prefix }) => {
    const directory = await createConsumerApp();
    let server: ReturnType<typeof startProcess> | undefined;
    let viewToClose: InstanceType<typeof Bun.WebView> | undefined;
    try {
      if (mode === "production") {
        const builder = Bun.spawn(
          [
            process.execPath,
            "node_modules/@teyik0/furin/src/cli/index.ts",
            "build",
            "--target",
            "bun",
          ],
          { cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 30_000 }
        );
        const [code, stdout, stderr] = await Promise.all([
          builder.exited,
          new Response(builder.stdout).text(),
          new Response(builder.stderr).text(),
        ]);
        expect(code, `${stdout}\n${stderr}`).toBe(0);
      }
      const port = await getFreePort();
      const origin = `http://127.0.0.1:${port}`;
      server = startProcess(
        mode === "development"
          ? [process.execPath, "--hot", "src/server.ts"]
          : [process.execPath, ".furin/build/bun/server.js"],
        {
          cwd: directory,
          env: { NODE_ENV: mode, PORT: String(port) },
        }
      );
      const errors: string[] = [];
      const view = new Bun.WebView({
        backend: { type: "chrome", url: false },
        console(type, ...messages) {
          if (type === "error") {
            errors.push(messages.map(String).join(" "));
          }
        },
      });
      viewToClose = view;
      const documents: string[] = [];
      await waitForHttp(`${origin}${prefix}/`, { timeoutMs: 15_000 });
      await view.navigate("about:blank");
      await view.cdp("Network.enable");
      if (mode === "production") {
        // SSR markup can arrive before the lazy hydration modules on a slow connection.
        await view.cdp("Network.emulateNetworkConditions", {
          offline: false,
          latency: 200,
          downloadThroughput: 128 * 1024,
          uploadThroughput: 128 * 1024,
        });
      }
      view.addEventListener("Network.requestWillBeSent", (event) => {
        const request = (
          event as unknown as { data?: { type?: string; request?: { url?: string } } }
        ).data;
        if (request?.type === "Document" && request.request?.url) {
          documents.push(request.request.url);
        }
      });
      await view.navigate(`${origin}${prefix}/`);
      await waitFor(
        view,
        'document.querySelector("[data-testid=counter]")?.getAttribute("data-hydrated") === "true"'
      );
      await view.click('[data-testid="counter"]');
      await waitFor(
        view,
        'document.querySelector("[data-testid=counter]")?.textContent === "Count 1"'
      );
      const marker = (await view.evaluate(
        "window.__furinCompositeDocument = crypto.randomUUID()"
      )) as string;
      expect(documents).toContain(`${origin}${prefix}/`);
      documents.length = 0;
      const navigate = async (kind: "classic" | "composite", page: "home" | "other") => {
        await view.click(`[data-testid="${kind}-${page}"]`);
        const path = `${prefix}/${page === "home" ? "" : page}`;
        await waitFor(
          view,
          `location.pathname === ${JSON.stringify(path)} && document.querySelector('[data-page="${page}"]') !== null`
        );
        const snapshot = (await view.evaluate(`({
          marker: window.__furinCompositeDocument,
          count: document.querySelector('[data-testid="counter"]')?.textContent ?? null,
          href: document.querySelector('[data-testid="composite-other"]')?.getAttribute('href') ?? null,
        })`)) as NavigationSnapshot;
        expect(snapshot.marker).toBe(marker);
        expect(snapshot.count).toBe("Count 1");
        expect(snapshot.href).toBe(`${prefix}/other`);
        expect(documents).toEqual([]);
      };
      await navigate("classic", "other");
      await navigate("composite", "home");
      await navigate("composite", "other");
      await navigate("classic", "home");

      if (mode === "development") {
        await Bun.write(
          join(directory, "src/header.tsx"),
          headerSource.replace("header-v1", "header-v2")
        );
        await waitFor(
          view,
          'document.querySelector("[data-testid=header-version]")?.textContent === "header-v2"'
        );
        await navigate("classic", "other");
        await navigate("composite", "home");
        await Bun.write(
          join(directory, `src/${prefix ? "admin" : "pages"}/root.tsx`),
          rootSource.replace("composite-v1", "composite-v2")
        );
        await waitFor(
          view,
          'document.querySelector("[data-testid=composite-version]")?.textContent === "composite-v2"'
        );
        await navigate("composite", "other");
        await navigate("classic", "home");
      }
      expect(errors).toEqual([]);
    } finally {
      viewToClose?.close();
      server?.kill();
      await server?.exitCode;
      rmSync(directory, { force: true, maxRetries: 50, recursive: true, retryDelay: 100 });
    }
  },
  60_000
);
