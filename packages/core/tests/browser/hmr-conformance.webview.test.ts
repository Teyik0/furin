// biome-ignore-all lint/performance/noAwaitInLoops: browser HMR assertions poll observable UI state
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, removeAppPath, type TmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { getFreePort } from "../support/hmr.ts";
import { type HmrProxy, startHmrProxy } from "../support/hmr-proxy.ts";
import { waitForHttp } from "../support/http.ts";
import { type RunningCli, startProcess } from "../support/process.ts";

const browserTest = process.env.FURIN_WEBVIEW_TESTS === "1" ? test : test.skip;
// Keep timing-sensitive Bun HMR gaps as executable specifications without making
// the supported CI matrix depend on whether a gap reproduces on a given runner.
const browserTodoTest = process.env.FURIN_WEBVIEW_TESTS === "1" ? test.todo : test.skip;
const soakTest =
  process.env.FURIN_WEBVIEW_TESTS === "1" && process.env.FURIN_HMR_SOAK_TESTS === "1"
    ? test
    : test.skip;
const soakEditCount = Number(process.env.FURIN_HMR_SOAK_EDITS ?? "2000");
if (!Number.isSafeInteger(soakEditCount) || soakEditCount < 1) {
  throw new Error("FURIN_HMR_SOAK_EDITS must be a positive integer");
}

interface BrowserSnapshot {
  count: string | null;
  documentId: string | undefined;
  version: string | undefined;
}

interface PaintMeasurement {
  latencyMs: number;
  paintedAt: number;
  version: string;
}

interface RuntimeHeapUsage {
  usedSize: number;
}

interface SoakMemorySample {
  browserHeapBytes: number;
  edit: number;
  serverRssBytes: number;
}

interface InitialAppFile {
  contents: string;
  relativePath: string;
}

interface BrowserHarness {
  app: TmpApp;
  consoleErrors: string[];
  extraViews: InstanceType<typeof Bun.WebView>[];
  hmrFrames: string[];
  proxy: HmrProxy | undefined;
  server: RunningCli;
  url: string;
  view: InstanceType<typeof Bun.WebView>;
  webSocketClosed: number[];
  webSocketHandshakes: number[];
  webSocketUrls: string[];
}

interface WebSocketFrameEvent extends Event {
  data?: {
    response?: {
      payloadData?: string;
    };
  };
}

interface WebSocketCreatedEvent extends Event {
  data?: {
    url?: string;
  };
}

let activeHarness: BrowserHarness | undefined;

function pageSource(version: string, changedHookSignature: boolean): string {
  return [
    'import { useState } from "react";',
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    "function CounterPage() {",
    ...(changedHookSignature ? ['  const [signature] = useState("changed-hooks");'] : []),
    "  const [count, setCount] = useState(0);",
    "  return (",
    `    <main data-signature={${changedHookSignature ? "signature" : '"stable-hooks"'}} data-version="${version}">`,
    '      <output data-testid="count">{count}</output>',
    '      <button data-testid="increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment",
    "      </button>",
    "    </main>",
    "  );",
    "}",
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    "  .page(CounterPage);",
  ].join("\n");
}

function paintPageSource(version: string, editedAt: number): string {
  return pageSource(version, false).replace(
    `data-version="${version}"`,
    `data-edited-at="${editedAt}" data-version="${version}"`
  );
}

function importedChildPageSource(importPath: string): string {
  return [
    'import { useState } from "react";',
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    `import { ChildCounter } from ${JSON.stringify(importPath)};`,
    "",
    "function ParentPage() {",
    "  const [count, setCount] = useState(0);",
    "  return (",
    '    <main data-version="imported-child">',
    '      <output data-testid="count">{count}</output>',
    '      <button data-testid="increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment parent",
    "      </button>",
    "      <ChildCounter />",
    "    </main>",
    "  );",
    "}",
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    "  .page(ParentPage);",
  ].join("\n");
}

function importedChildSource(version: string): string {
  return [
    'import { useState } from "react";',
    "",
    "export function ChildCounter() {",
    "  const [count, setCount] = useState(0);",
    "  return (",
    `    <section data-child-version="${version}">`,
    `      <output data-testid="child-count">${version}:{count}</output>`,
    '      <button data-testid="child-increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment child",
    "      </button>",
    "    </section>",
    "  );",
    "}",
  ].join("\n");
}

function importedRoutePageSource(): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { ImportedPage } from "../components/ImportedPage";',
    'import { route as rootRoute } from "./root";',
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    "  .page(ImportedPage);",
  ].join("\n");
}

function importedRouteComponentSource(version: string, includeSecondHook: boolean): string {
  return [
    'import { useState } from "react";',
    "export function ImportedPage() {",
    "  const [count, setCount] = useState(0);",
    ...(includeSecondHook ? ['  useState("new-hook");'] : []),
    "  return (",
    `    <main data-version="${version}">`,
    '      <output data-testid="count">{count}</output>',
    '      <button data-testid="increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment",
    "      </button>",
    "    </main>",
    "  );",
    "}",
  ].join("\n");
}

function mixedExportPageSource(): string {
  return importedChildPageSource("../components/MixedChild")
    .replace(
      'import { ChildCounter } from "../components/MixedChild";',
      [
        'import { ChildCounter, childLabel } from "../components/MixedChild";',
        "",
        "function ChildLabel() {",
        '  return <output data-testid="child-label">{childLabel}</output>;',
        "}",
      ].join("\n")
    )
    .replace("      <ChildCounter />", "      <ChildLabel />\n      <ChildCounter />");
}

function mixedExportChildSource(version: string): string {
  return [
    'import { useState } from "react";',
    "",
    `export const childLabel = "label-${version}";`,
    "",
    "export function ChildCounter() {",
    "  const [count, setCount] = useState(0);",
    "  return (",
    `    <section data-child-version="${version}">`,
    `      <output data-testid="child-count">${version}:{count}</output>`,
    '      <button data-testid="child-increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment child",
    "      </button>",
    "    </section>",
    "  );",
    "}",
  ].join("\n");
}

function cyclicChildSource(): string {
  return [
    'import { useState } from "react";',
    'import { cycleLabel } from "./cycle-label";',
    "",
    "export function ChildCounter() {",
    "  const [count, setCount] = useState(0);",
    "  return (",
    "    <section data-child-version={cycleLabel}>",
    '      <output data-testid="child-count">{cycleLabel}:{count}</output>',
    '      <button data-testid="child-increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment child",
    "      </button>",
    "    </section>",
    "  );",
    "}",
  ].join("\n");
}

function cyclicLabelSource(version: string): string {
  return [
    'import { ChildCounter } from "./CycleChild";',
    "",
    `export const cycleLabel = "${version}";`,
    "export function getCycleComponent() {",
    "  return ChildCounter;",
    "}",
  ].join("\n");
}

function dynamicImportPageSource(): string {
  return [
    'import { lazy, Suspense, useState } from "react";',
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    'const LazyChild = lazy(() => import("../components/LazyChild").then((module) => ({',
    "  default: module.LazyChild,",
    "})));",
    "",
    "function DynamicPage() {",
    "  const [count, setCount] = useState(0);",
    "  const [shown, setShown] = useState(false);",
    "  return (",
    '    <main data-version="dynamic">',
    '      <output data-testid="count">{count}</output>',
    '      <button data-testid="increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment parent",
    "      </button>",
    '      <button data-testid="show-lazy" onClick={() => setShown(true)}>',
    "        Show lazy child",
    "      </button>",
    '      <Suspense fallback={<output data-testid="lazy-loading">Loading</output>}>',
    "        {shown ? <LazyChild /> : null}",
    "      </Suspense>",
    "    </main>",
    "  );",
    "}",
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    "  .page(DynamicPage);",
  ].join("\n");
}

function lazyChildSource(version: string): string {
  return importedChildSource(version).replace("ChildCounter", "LazyChild");
}

function missingImportPageSource(version: string): string {
  return pageSource(version, false)
    .replace(
      'import { route as rootRoute } from "./root";',
      'import { route as rootRoute } from "./root";\nimport { MissingChild } from "../components/MissingChild";'
    )
    .replace("    </main>", "      <MissingChild />\n    </main>");
}

function topologyHomeSource(): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { Link } from "@teyik0/furin/link";',
    'import { route as rootRoute } from "./root";',
    "",
    "function HomePage() {",
    "  return (",
    '    <main data-version="topology-home">',
    '      <Link data-testid="added-link" to="/added">Open added route</Link>',
    "    </main>",
    "  );",
    "}",
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    "  .page(HomePage);",
  ].join("\n");
}

function addedRouteSource(version: string): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    `function AddedPage() { return <main data-version="${version}">Added route</main>; }`,
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    "  .page(AddedPage);",
  ].join("\n");
}

function multiInstanceServerSource(): string {
  return [
    'import { furin } from "@teyik0/furin";',
    'import Elysia from "elysia";',
    "",
    "const port = Number(process.env.PORT);",
    "const app = new Elysia()",
    '  .use(await furin({ pagesDir: import.meta.dir + "/pages" }))',
    '  .use(await furin({ pagesDir: import.meta.dir + "/admin-pages", prefix: "/admin" }))',
    "  .listen(port);",
    "",
    'console.log("[test-app] listening on " + app.server?.port);',
  ].join("\n");
}

function sectionLayoutSource(version: string): string {
  return [
    'import { useState } from "react";',
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "../root";',
    "",
    "function SectionLayout({ children }: { children: React.ReactNode }) {",
    "  const [count, setCount] = useState(0);",
    "  return (",
    `    <section data-layout-version="${version}">`,
    `      <output data-testid="layout-version">${version}</output>`,
    '      <output data-testid="layout-count">{count}</output>',
    '      <button data-testid="layout-increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment layout",
    "      </button>",
    "      {children}",
    "    </section>",
    "  );",
    "}",
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    "  .layout(SectionLayout);",
  ].join("\n");
}

function sectionPageSource(version: string): string {
  return [
    'import { useState } from "react";',
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as sectionRoute } from "./_route";',
    "",
    "function SectionPage() {",
    "  const [count, setCount] = useState(0);",
    "  return (",
    `    <main data-version="${version}">`,
    '      <output data-testid="count">{count}</output>',
    '      <button data-testid="increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment page",
    "      </button>",
    "    </main>",
    "  );",
    "}",
    "",
    "export const route = defineRoute()",
    '  .config({ layout: sectionRoute, mode: "ssr" })',
    "  .page(SectionPage);",
  ].join("\n");
}

function loaderPageSource(version: string, loaderThrows: boolean): string {
  const loader = loaderThrows
    ? '  .loader(() => { throw new Error("server loader exploded"); })'
    : `  .loader(() => ({ message: "loader-${version}" }))`;
  return [
    'import { useState } from "react";',
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    "function LoaderPage({ data }: { data: { message: string } }) {",
    "  const [count, setCount] = useState(0);",
    "  return (",
    `    <main data-version="${version}">`,
    '      <output data-testid="loader">{data.message}</output>',
    '      <output data-testid="count">{count}</output>',
    '      <button data-testid="increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment",
    "      </button>",
    "    </main>",
    "  );",
    "}",
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    loader,
    "  .page(LoaderPage);",
  ].join("\n");
}

function slowLoaderPageSource(version: string, delayMs: number): string {
  return loaderPageSource(version, false).replace(
    `  .loader(() => ({ message: "loader-${version}" }))`,
    `  .loader(async () => { await Bun.sleep(${delayMs}); return { message: "loader-${version}" }; })`
  );
}

function renderingModePageSource(version: string, mode: "isr" | "ssg" | "ssr"): string {
  const config =
    mode === "isr"
      ? '.config({ layout: rootRoute, mode: "isr", revalidate: 60 })'
      : `.config({ layout: rootRoute, mode: "${mode}" })`;
  return loaderPageSource(version, false).replace(
    '.config({ layout: rootRoute, mode: "ssr" })',
    config
  );
}

function deferredPageSource(version: string): string {
  return [
    'import { Suspense, useState } from "react";',
    'import { Await, defer, defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    "",
    "function DeferredPage({ data }: { data: { message: Promise<string> } }) {",
    "  const [count, setCount] = useState(0);",
    "  return (",
    `    <main data-version="${version}">`,
    '      <output data-testid="count">{count}</output>',
    '      <button data-testid="increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment",
    "      </button>",
    '      <Suspense fallback={<output data-testid="deferred">loading</output>}>',
    '        <Await resolve={data.message}>{(message) => <output data-testid="deferred">{message}</output>}</Await>',
    "      </Suspense>",
    "    </main>",
    "  );",
    "}",
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    `  .loader(() => defer({ message: Bun.sleep(100).then(() => "deferred-${version}") }))`,
    "  .page(DeferredPage);",
  ].join("\n");
}

function rscPageSource(version: string): string {
  return [
    'import { useState } from "react";',
    'import { defineRoute } from "@teyik0/furin";',
    'import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";',
    'import { route as rootRoute } from "./root";',
    "",
    "function RscPage({ data }) {",
    "  const [count, setCount] = useState(0);",
    "  return (",
    `    <main data-version="${version}">`,
    '      <output data-testid="count">{count}</output>',
    '      <button data-testid="increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment",
    "      </button>",
    "      <CompositeComponent src={data.card} />",
    "    </main>",
    "  );",
    "}",
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    "  .loader(async () => ({",
    "    card: await createCompositeComponent(() => (",
    `      <article data-testid="rsc-value">rsc-${version}</article>`,
    "    )),",
    "  }))",
    "  .page(RscPage);",
  ].join("\n");
}

function cssPageSource(): string {
  return [
    'import { useState } from "react";',
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    'import "./styles.css";',
    "",
    "function CssPage() {",
    "  const [count, setCount] = useState(0);",
    "  return (",
    '    <main className="hmr-color" data-version="css">',
    '      <output data-testid="count">{count}</output>',
    '      <button data-testid="increment" onClick={() => setCount((value) => value + 1)}>',
    "        Increment",
    "      </button>",
    "    </main>",
    "  );",
    "}",
    "",
    "export const route = defineRoute()",
    '  .config({ layout: rootRoute, mode: "ssr" })',
    "  .page(CssPage);",
  ].join("\n");
}

function cssModulePageSource(): string {
  return cssPageSource()
    .replace('import "./styles.css";', 'import styles from "./styles.module.css";')
    .replace('className="hmr-color"', "className={styles.color}");
}

function rootSource(version: string): string {
  return [
    'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";',
    "",
    "export const route = defineRootRoute()",
    '  .config({ mode: "ssr" })',
    "  .layout(({ children }) => (",
    '    <html className="dark" lang="en">',
    "      <head><HeadContent /></head>",
    `      <body><output data-testid="root-version">${version}</output>{children}<Scripts /></body>`,
    "    </html>",
    "  ));",
  ].join("\n");
}

async function createBrowserHarness(
  initialPageSource: string,
  initialFiles: readonly InitialAppFile[],
  proxyHmrTransport: boolean
): Promise<BrowserHarness> {
  const app = createTmpApp("cli-app");
  writeAppFile(app.path, "src/pages/root.tsx", rootSource("root-v1"));
  writeAppFile(app.path, "src/pages/index.tsx", initialPageSource);
  for (const file of initialFiles) {
    writeAppFile(app.path, file.relativePath, file.contents);
  }

  const port = await getFreePort();
  const server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
    cwd: app.path,
    env: { PORT: String(port) },
  });

  await waitForHttp(`http://127.0.0.1:${port}/_bun_hmr_entry`, {
    intervalMs: 100,
    timeoutMs: 15_000,
  });
  const browserPort = proxyHmrTransport ? await getFreePort() : port;
  const proxy = proxyHmrTransport ? await startHmrProxy(browserPort, port) : undefined;

  const consoleErrors: string[] = [];
  const hmrFrames: string[] = [];
  const webSocketClosed: number[] = [];
  const webSocketHandshakes: number[] = [];
  const webSocketUrls: string[] = [];
  const view = new Bun.WebView({
    backend: { type: "chrome", url: false },
    console: (type, ...args) => {
      if (type !== "error") {
        return;
      }
      consoleErrors.push(
        args
          .map((value) => {
            if (typeof value === "string") {
              return value;
            }
            if (value && typeof value === "object" && "description" in value) {
              const remote = value as { description?: unknown };
              return typeof remote.description === "string" ? remote.description : String(value);
            }
            return String(value);
          })
          .join(" ")
      );
    },
    height: 720,
    width: 1280,
  });
  await view.navigate("about:blank");
  await view.cdp("Network.enable");
  view.addEventListener("Network.webSocketFrameReceived", (event) => {
    const payload = (event as unknown as WebSocketFrameEvent).data?.response?.payloadData;
    if (payload) {
      hmrFrames.push(payload);
    }
  });
  view.addEventListener("Network.webSocketCreated", (event) => {
    const url = (event as unknown as WebSocketCreatedEvent).data?.url;
    if (url) {
      webSocketUrls.push(url);
    }
  });
  view.addEventListener("Network.webSocketClosed", () => {
    webSocketClosed.push(Date.now());
  });
  view.addEventListener("Network.webSocketHandshakeResponseReceived", () => {
    webSocketHandshakes.push(Date.now());
  });
  await view.navigate(`http://127.0.0.1:${browserPort}/`);
  const url = `http://127.0.0.1:${browserPort}`;

  return {
    app,
    consoleErrors,
    extraViews: [],
    hmrFrames,
    proxy,
    server,
    url,
    view,
    webSocketClosed,
    webSocketHandshakes,
    webSocketUrls,
  };
}

async function readSnapshot(view: InstanceType<typeof Bun.WebView>): Promise<BrowserSnapshot> {
  return (await view.evaluate(`({
    count: document.querySelector('[data-testid="count"]')?.textContent ?? null,
    documentId: window.__furinTestDocumentId,
    version: document.querySelector('main')?.dataset.version,
  })`)) as BrowserSnapshot;
}

async function waitForVersion(
  view: InstanceType<typeof Bun.WebView>,
  version: string
): Promise<BrowserSnapshot> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const snapshot = await readSnapshot(view);
      if (snapshot.version === version) {
        return snapshot;
      }
    } catch {
      // A full reload may briefly replace the inspected target.
    }
    if (Date.now() - startedAt >= 15_000) {
      throw new Error(`Timed out waiting for browser HMR version ${version}`);
    }
    await Bun.sleep(50);
  }
}

async function waitForPaintMeasurement(
  view: InstanceType<typeof Bun.WebView>
): Promise<PaintMeasurement> {
  const startedAt = Date.now();
  for (;;) {
    const measurement = (await view.evaluate(
      "window.__furinHmrPaint ?? null"
    )) as PaintMeasurement | null;
    if (measurement) {
      return measurement;
    }
    if (Date.now() - startedAt >= 15_000) {
      throw new Error("Timed out waiting for the browser paint measurement");
    }
    await Bun.sleep(50);
  }
}

async function readServerRss(pid: number): Promise<number> {
  const process = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Could not read server RSS: ${stderr.trim()}`);
  }
  const rssKibibytes = Number.parseInt(stdout.trim(), 10);
  if (!Number.isFinite(rssKibibytes)) {
    throw new Error(`Invalid server RSS returned by ps: ${stdout.trim()}`);
  }
  return rssKibibytes * 1024;
}

async function collectMemorySample(
  harness: BrowserHarness,
  edit: number
): Promise<SoakMemorySample> {
  await harness.view.cdp("HeapProfiler.collectGarbage");
  const heap = (await harness.view.cdp("Runtime.getHeapUsage")) as RuntimeHeapUsage;
  return {
    browserHeapBytes: heap.usedSize,
    edit,
    serverRssBytes: await readServerRss(harness.server.pid),
  };
}

function percentile(values: readonly number[], ratio: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(Math.floor(sorted.length * ratio), sorted.length - 1)] ?? 0;
}

async function waitForConsoleError(harness: BrowserHarness): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    const error = harness.consoleErrors.at(-1);
    if (error) {
      return error;
    }
    if (Date.now() - startedAt >= 15_000) {
      throw new Error("Timed out waiting for a browser console error");
    }
    await Bun.sleep(50);
  }
}

async function waitForHmrFrame(harness: BrowserHarness): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    const frame = harness.hmrFrames.at(-1);
    if (frame) {
      return frame;
    }
    if (Date.now() - startedAt >= 15_000) {
      throw new Error("Timed out waiting for an HMR WebSocket frame");
    }
    await Bun.sleep(50);
  }
}

async function waitForBodyText(
  view: InstanceType<typeof Bun.WebView>,
  expectedText: string
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const bodyText = await view.evaluate("document.body?.innerText ?? ''");
      if (typeof bodyText === "string" && bodyText.includes(expectedText)) {
        return;
      }
    } catch {
      // A full reload may briefly replace the inspected target.
    }
    if (Date.now() - startedAt >= 15_000) {
      throw new Error(`Timed out waiting for browser text ${expectedText}`);
    }
    await Bun.sleep(50);
  }
}

async function waitForProxyWebSocketCount(proxy: HmrProxy, expectedCount: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (proxy.webSocketCount() >= expectedCount) {
      return;
    }
    if (Date.now() - startedAt >= 20_000) {
      throw new Error(`Timed out waiting for ${expectedCount} proxied WebSocket connections`);
    }
    await Bun.sleep(50);
  }
}

async function waitForHttpBody(url: string, expectedText: string): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok && body.includes(expectedText)) {
        return;
      }
    } catch {
      // The topology watcher may be swapping the route snapshot between polls.
    }
    if (Date.now() - startedAt >= 15_000) {
      throw new Error(`Timed out waiting for ${url} to contain ${expectedText}`);
    }
    await Bun.sleep(50);
  }
}

async function waitForHttpStatus(url: string, expectedStatus: number): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).status === expectedStatus) {
        return;
      }
    } catch {
      // The topology watcher may be swapping the route snapshot between polls.
    }
    if (Date.now() - startedAt >= 15_000) {
      throw new Error(`Timed out waiting for ${url} to return ${expectedStatus}`);
    }
    await Bun.sleep(50);
  }
}

async function waitForStableDocument(view: InstanceType<typeof Bun.WebView>): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const marker = (await view.evaluate(
        "(() => { window.__furinStabilityMarker = crypto.randomUUID(); return window.__furinStabilityMarker; })()"
      )) as string;
      await Bun.sleep(300);
      if ((await view.evaluate("window.__furinStabilityMarker")) === marker) {
        return;
      }
    } catch {
      // A topology rebuild may still be replacing the inspected target.
    }
    if (Date.now() - startedAt >= 15_000) {
      throw new Error("Timed out waiting for the browser document to stabilize");
    }
  }
}

async function waitForElementText(
  view: InstanceType<typeof Bun.WebView>,
  selector: string,
  expectedText: string
): Promise<void> {
  const startedAt = Date.now();
  let latestText: unknown;
  for (;;) {
    latestText = await view.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`
    );
    if (latestText === expectedText) {
      return;
    }
    if (Date.now() - startedAt >= 15_000) {
      throw new Error(
        `Timed out waiting for ${selector} to contain ${expectedText}; latest value was ${String(latestText)}`
      );
    }
    await Bun.sleep(50);
  }
}

async function waitForComputedColor(
  view: InstanceType<typeof Bun.WebView>,
  expectedColor: string
): Promise<void> {
  const startedAt = Date.now();
  let latestColor: unknown;
  for (;;) {
    latestColor = await view.evaluate(`(() => {
      const main = document.querySelector('main');
      return main ? getComputedStyle(main).color : "missing main: " + document.body.innerText;
    })()`);
    if (latestColor === expectedColor) {
      return;
    }
    if (Date.now() - startedAt >= 15_000) {
      throw new Error(
        `Timed out waiting for computed color ${expectedColor}; latest value was ${String(latestColor)}`
      );
    }
    await Bun.sleep(50);
  }
}

async function waitForWebSocketConnectionCount(
  harness: BrowserHarness,
  expectedCount: number
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (harness.webSocketUrls.length >= expectedCount) {
      return;
    }
    if (Date.now() - startedAt >= 20_000) {
      throw new Error(`Timed out waiting for WebSocket connection ${expectedCount}`);
    }
    await Bun.sleep(50);
  }
}

async function waitForWebSocketClosedCount(
  harness: BrowserHarness,
  expectedCount: number
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (harness.webSocketClosed.length >= expectedCount) {
      return;
    }
    if (Date.now() - startedAt >= 10_000) {
      throw new Error(`Timed out waiting for closed WebSocket ${expectedCount}`);
    }
    await Bun.sleep(50);
  }
}

async function waitForWebSocketHandshakeCount(
  harness: BrowserHarness,
  expectedCount: number
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (harness.webSocketHandshakes.length >= expectedCount) {
      return;
    }
    if (Date.now() - startedAt >= 20_000) {
      throw new Error(`Timed out waiting for WebSocket handshake ${expectedCount}`);
    }
    await Bun.sleep(50);
  }
}

function closeBrowserHarness(harness: BrowserHarness): void {
  harness.view.close();
  for (const view of harness.extraViews) {
    view.close();
  }
  harness.proxy?.close();
  harness.server.kill();
  harness.app.cleanup();
}

afterEach(() => {
  if (activeHarness) {
    closeBrowserHarness(activeHarness);
  }
  activeHarness = undefined;
});

browserTest(
  "a component edit preserves React state without reloading the document",
  async () => {
    const harness = await createBrowserHarness(pageSource("v1", false), [], false);
    activeHarness = harness;

    await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    );
    await harness.view.click('[data-testid="increment"]');
    await harness.view.click('[data-testid="increment"]');

    const before = await readSnapshot(harness.view);
    expect(before.count).toBe("2");
    expect(before.version).toBe("v1");

    writeAppFile(harness.app.path, "src/pages/index.tsx", pageSource("v2", false));

    const after = await waitForVersion(harness.view, "v2");
    expect(after.count).toBe("2");
    expect(after.documentId).toBe(before.documentId);
  },
  30_000
);

browserTest(
  "a hook signature change remounts the component without reloading the document",
  async () => {
    const harness = await createBrowserHarness(pageSource("v1", false), [], false);
    activeHarness = harness;

    await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    );
    await harness.view.click('[data-testid="increment"]');
    await harness.view.click('[data-testid="increment"]');
    const before = await readSnapshot(harness.view);

    writeAppFile(harness.app.path, "src/pages/index.tsx", pageSource("hooks-v2", true));

    const after = await waitForVersion(harness.view, "hooks-v2");
    expect(after.count).toBe("0");
    expect(after.documentId).toBe(before.documentId);
    const signature = (await harness.view.evaluate(
      "document.querySelector('main')?.dataset.signature"
    )) as string | undefined;
    expect(signature).toBe("changed-hooks");
  },
  30_000
);

browserTest(
  "an imported route component remounts when its hook signature changes",
  async () => {
    const harness = await createBrowserHarness(
      importedRoutePageSource(),
      [
        {
          contents: importedRouteComponentSource("imported-v1", false),
          relativePath: "src/components/ImportedPage.tsx",
        },
      ],
      false
    );
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');

    writeAppFile(
      harness.app.path,
      "src/components/ImportedPage.tsx",
      importedRouteComponentSource("imported-v2", true)
    );

    const after = await waitForVersion(harness.view, "imported-v2");
    expect(after.count).toBe("0");
    expect(after.documentId).toBe(documentId);
  },
  30_000
);

browserTest(
  "an imported child edit preserves parent and child React state",
  async () => {
    const harness = await createBrowserHarness(
      importedChildPageSource("../components/ChildCounter"),
      [
        {
          contents: importedChildSource("child-v1"),
          relativePath: "src/components/ChildCounter.tsx",
        },
      ],
      false
    );
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    await harness.view.click('[data-testid="child-increment"]');

    writeAppFile(
      harness.app.path,
      "src/components/ChildCounter.tsx",
      importedChildSource("child-v2")
    );

    await waitForElementText(harness.view, '[data-testid="child-count"]', "child-v2:1");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  30_000
);

browserTest(
  "an edit propagates through a re-export while preserving React state",
  async () => {
    const harness = await createBrowserHarness(
      importedChildPageSource("../components"),
      [
        {
          contents: importedChildSource("barrel-v1"),
          relativePath: "src/components/ChildCounter.tsx",
        },
        {
          contents: 'export { ChildCounter } from "./ChildCounter";',
          relativePath: "src/components/index.ts",
        },
      ],
      false
    );
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    await harness.view.click('[data-testid="child-increment"]');

    writeAppFile(
      harness.app.path,
      "src/components/ChildCounter.tsx",
      importedChildSource("barrel-v2")
    );

    await waitForElementText(harness.view, '[data-testid="child-count"]', "barrel-v2:1");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  30_000
);

browserTest(
  "a module with component and value exports invalidates its importers safely",
  async () => {
    const harness = await createBrowserHarness(
      mixedExportPageSource(),
      [
        {
          contents: mixedExportChildSource("mixed-v1"),
          relativePath: "src/components/MixedChild.tsx",
        },
      ],
      false
    );
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    await harness.view.click('[data-testid="child-increment"]');

    writeAppFile(
      harness.app.path,
      "src/components/MixedChild.tsx",
      mixedExportChildSource("mixed-v2")
    );

    await waitForElementText(harness.view, '[data-testid="child-label"]', "label-mixed-v2");
    await waitForElementText(harness.view, '[data-testid="child-count"]', "mixed-v2:1");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  30_000
);

browserTest(
  "an edit propagates through a cyclic import graph without losing state",
  async () => {
    const harness = await createBrowserHarness(
      importedChildPageSource("../components/CycleChild"),
      [
        {
          contents: cyclicChildSource(),
          relativePath: "src/components/CycleChild.tsx",
        },
        {
          contents: cyclicLabelSource("cycle-v1"),
          relativePath: "src/components/cycle-label.ts",
        },
      ],
      false
    );
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    await harness.view.click('[data-testid="child-increment"]');

    writeAppFile(harness.app.path, "src/components/cycle-label.ts", cyclicLabelSource("cycle-v2"));

    await waitForElementText(harness.view, '[data-testid="child-count"]', "cycle-v2:1");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  30_000
);

browserTodoTest(
  "a deleted imported component recovers when the file is restored",
  async () => {
    const harness = await createBrowserHarness(
      importedChildPageSource("../components/ChildCounter"),
      [
        {
          contents: importedChildSource("restore-v1"),
          relativePath: "src/components/ChildCounter.tsx",
        },
      ],
      false
    );
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    await harness.view.click('[data-testid="child-increment"]');
    harness.hmrFrames.length = 0;

    removeAppPath(harness.app.path, "src/components/ChildCounter.tsx");
    await waitForHmrFrame(harness);
    await waitForElementText(harness.view, '[data-testid="child-count"]', "restore-v1:1");

    writeAppFile(
      harness.app.path,
      "src/components/ChildCounter.tsx",
      importedChildSource("restore-v2")
    );

    await waitForElementText(harness.view, '[data-testid="child-count"]', "restore-v2:1");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  45_000
);

browserTest(
  "moving an imported component remounts it but preserves parent state",
  async () => {
    const harness = await createBrowserHarness(
      importedChildPageSource("../components/OldChild"),
      [
        {
          contents: importedChildSource("move-v1"),
          relativePath: "src/components/OldChild.tsx",
        },
      ],
      false
    );
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    await harness.view.click('[data-testid="child-increment"]');

    writeAppFile(harness.app.path, "src/components/NewChild.tsx", importedChildSource("move-v2"));
    writeAppFile(
      harness.app.path,
      "src/pages/index.tsx",
      importedChildPageSource("../components/NewChild")
    );
    removeAppPath(harness.app.path, "src/components/OldChild.tsx");

    await waitForElementText(harness.view, '[data-testid="child-count"]', "move-v2:0");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  45_000
);

browserTest(
  "an already loaded dynamic import refreshes while preserving state",
  async () => {
    const harness = await createBrowserHarness(
      dynamicImportPageSource(),
      [
        {
          contents: lazyChildSource("lazy-v1"),
          relativePath: "src/components/LazyChild.tsx",
        },
      ],
      false
    );
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    await harness.view.click('[data-testid="show-lazy"]');
    await waitForElementText(harness.view, '[data-testid="child-count"]', "lazy-v1:0");
    await harness.view.click('[data-testid="child-increment"]');

    writeAppFile(harness.app.path, "src/components/LazyChild.tsx", lazyChildSource("lazy-v2"));

    await waitForElementText(harness.view, '[data-testid="child-count"]', "lazy-v2:1");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  30_000
);

browserTodoTest(
  "a dynamic import edited before first load resolves to the latest module",
  async () => {
    const harness = await createBrowserHarness(
      dynamicImportPageSource(),
      [
        {
          contents: lazyChildSource("unloaded-v1"),
          relativePath: "src/components/LazyChild.tsx",
        },
      ],
      false
    );
    activeHarness = harness;

    writeAppFile(harness.app.path, "src/components/LazyChild.tsx", lazyChildSource("unloaded-v2"));
    await waitForHmrFrame(harness);
    await harness.view.click('[data-testid="show-lazy"]');
    await waitForElementText(harness.view, '[data-testid="child-count"]', "unloaded-v2:0");
  },
  30_000
);

browserTest(
  "a root layout edit preserves page state without reloading the document",
  async () => {
    const harness = await createBrowserHarness(pageSource("root-page", false), [], false);
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');

    writeAppFile(harness.app.path, "src/pages/root.tsx", rootSource("root-v2"));

    await waitForElementText(harness.view, '[data-testid="root-version"]', "root-v2");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  30_000
);

browserTest(
  "an intermediate layout edit preserves its state and the nested page state",
  async () => {
    const harness = await createBrowserHarness(
      pageSource("home", false),
      [
        {
          contents: sectionLayoutSource("layout-v1"),
          relativePath: "src/pages/section/_route.tsx",
        },
        {
          contents: sectionPageSource("section-v1"),
          relativePath: "src/pages/section/index.tsx",
        },
      ],
      false
    );
    activeHarness = harness;
    await harness.view.navigate(`${harness.url}/section`);

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="layout-increment"]');
    await harness.view.click('[data-testid="increment"]');

    writeAppFile(
      harness.app.path,
      "src/pages/section/_route.tsx",
      sectionLayoutSource("layout-v2")
    );

    await waitForElementText(harness.view, '[data-testid="layout-version"]', "layout-v2");
    expect(
      (await harness.view.evaluate(
        "document.querySelector('[data-testid=\"layout-count\"]')?.textContent"
      )) as string | undefined
    ).toBe("1");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  30_000
);

browserTest(
  "a syntax error recovers without losing the last valid React state",
  async () => {
    const harness = await createBrowserHarness(pageSource("v1", false), [], false);
    activeHarness = harness;

    await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    );
    await harness.view.click('[data-testid="increment"]');
    await harness.view.click('[data-testid="increment"]');
    const before = await readSnapshot(harness.view);
    harness.consoleErrors.length = 0;
    harness.hmrFrames.length = 0;

    writeAppFile(
      harness.app.path,
      "src/pages/index.tsx",
      pageSource("broken", false).replace(".page(CounterPage);", ".page(CounterPage")
    );

    await waitForHmrFrame(harness);
    expect(await readSnapshot(harness.view)).toEqual(before);

    writeAppFile(harness.app.path, "src/pages/index.tsx", pageSource("recovered", false));

    const after = await waitForVersion(harness.view, "recovered");
    expect(after.count).toBe("2");
    expect(after.documentId).toBe(before.documentId);
  },
  45_000
);

browserTodoTest(
  "a missing imported file recovers when the file is created",
  async () => {
    const harness = await createBrowserHarness(pageSource("missing-v1", false), [], false);
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    harness.hmrFrames.length = 0;

    writeAppFile(
      harness.app.path,
      "src/pages/index.tsx",
      missingImportPageSource("missing-recovered")
    );
    await waitForHmrFrame(harness);
    expect((await readSnapshot(harness.view)).version).toBe("missing-v1");

    writeAppFile(
      harness.app.path,
      "src/components/MissingChild.tsx",
      'export function MissingChild() { return <output data-testid="missing-child">created</output>; }'
    );

    await Bun.sleep(1000);
    const after = await readSnapshot(harness.view);
    expect(after.version).toBe("missing-recovered");
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  45_000
);

browserTest(
  "a render error recovers after the next edit without reloading the document",
  async () => {
    const harness = await createBrowserHarness(pageSource("v1", false), [], false);
    activeHarness = harness;

    await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    );
    await harness.view.click('[data-testid="increment"]');
    const before = await readSnapshot(harness.view);
    harness.consoleErrors.length = 0;

    writeAppFile(
      harness.app.path,
      "src/pages/index.tsx",
      pageSource("broken-render", false).replace(
        "function CounterPage() {",
        'function CounterPage() {\n  throw new Error("client render exploded");'
      )
    );

    const error = await waitForConsoleError(harness);
    expect(error).toContain("client render exploded");

    writeAppFile(harness.app.path, "src/pages/index.tsx", pageSource("runtime-recovered", false));

    const after = await waitForVersion(harness.view, "runtime-recovered");
    expect(after.count).toBe("0");
    expect(after.documentId).toBe(before.documentId);
  },
  45_000
);

browserTest(
  "successive syntax and render errors recover on the next valid edit",
  async () => {
    const harness = await createBrowserHarness(pageSource("sequence-v1", false), [], false);
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    harness.hmrFrames.length = 0;

    writeAppFile(
      harness.app.path,
      "src/pages/index.tsx",
      pageSource("sequence-syntax", false).replace(".page(CounterPage);", ".page(CounterPage")
    );
    await waitForHmrFrame(harness);
    expect((await readSnapshot(harness.view)).version).toBe("sequence-v1");

    harness.consoleErrors.length = 0;
    writeAppFile(
      harness.app.path,
      "src/pages/index.tsx",
      pageSource("sequence-runtime", false).replace(
        "function CounterPage() {",
        'function CounterPage() {\n  throw new Error("sequential render exploded");'
      )
    );
    expect(await waitForConsoleError(harness)).toContain("sequential render exploded");

    writeAppFile(harness.app.path, "src/pages/index.tsx", pageSource("sequence-fixed", false));

    const after = await waitForVersion(harness.view, "sequence-fixed");
    expect(after.count).toBe("0");
    expect(after.documentId).toBe(documentId);
  },
  45_000
);

browserTest(
  "a loader error recovers after the next edit without reloading the document",
  async () => {
    const harness = await createBrowserHarness(loaderPageSource("v1", false), [], false);
    activeHarness = harness;

    await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    );
    await waitForElementText(harness.view, '[data-testid="loader"]', "loader-v1");
    await harness.view.click('[data-testid="increment"]');
    const before = await readSnapshot(harness.view);

    writeAppFile(harness.app.path, "src/pages/index.tsx", loaderPageSource("broken-loader", true));

    await waitForBodyText(harness.view, "Something went wrong");

    writeAppFile(
      harness.app.path,
      "src/pages/index.tsx",
      loaderPageSource("recovered-loader", false)
    );

    const after = await waitForVersion(harness.view, "recovered-loader");
    await harness.view.evaluate("window.__FURIN_HMR_REFRESH__?.() ?? null");
    await waitForElementText(harness.view, '[data-testid="loader"]', "loader-recovered-loader");
    expect(after.count).toBe("0");
    expect(after.documentId).toBe(before.documentId);
  },
  45_000
);

browserTest(
  "a cold SSR error recovers after an edit without a manual reload",
  async () => {
    const harness = await createBrowserHarness(loaderPageSource("cold-broken", true), [], false);
    activeHarness = harness;

    await waitForBodyText(harness.view, "Something went wrong");
    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;

    writeAppFile(
      harness.app.path,
      "src/pages/index.tsx",
      loaderPageSource("cold-recovered", false)
    );

    const after = await waitForVersion(harness.view, "cold-recovered");
    await waitForElementText(harness.view, '[data-testid="loader"]', "loader-cold-recovered");
    expect(after.documentId).toBe(documentId);
  },
  45_000
);

browserTest(
  "a CSS edit updates computed styles without resetting React state",
  async () => {
    const harness = await createBrowserHarness(
      cssPageSource(),
      [
        {
          contents: ".hmr-color { color: rgb(255, 0, 0); }",
          relativePath: "src/pages/styles.css",
        },
      ],
      false
    );
    activeHarness = harness;

    await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    );
    await waitForComputedColor(harness.view, "rgb(255, 0, 0)");
    await harness.view.click('[data-testid="increment"]');
    const before = await readSnapshot(harness.view);

    writeAppFile(harness.app.path, "src/pages/styles.css", ".hmr-color { color: rgb(0, 0, 255); }");

    await waitForComputedColor(harness.view, "rgb(0, 0, 255)");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(before.documentId);
  },
  30_000
);

browserTest(
  "an invalid CSS edit keeps the last valid style and recovers",
  async () => {
    const harness = await createBrowserHarness(
      cssPageSource(),
      [
        {
          contents: ".hmr-color { color: rgb(255, 0, 0); }",
          relativePath: "src/pages/styles.css",
        },
      ],
      false
    );
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    harness.hmrFrames.length = 0;

    writeAppFile(harness.app.path, "src/pages/styles.css", ".hmr-color { color: rgb(; }");
    await waitForHmrFrame(harness);
    expect(
      (await harness.view.evaluate(
        "getComputedStyle(document.querySelector('main')).color"
      )) as string
    ).toBe("rgb(255, 0, 0)");

    writeAppFile(harness.app.path, "src/pages/styles.css", ".hmr-color { color: rgb(0, 128, 0); }");

    await waitForComputedColor(harness.view, "rgb(0, 128, 0)");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  45_000
);

browserTest(
  "an imported stylesheet dependency updates without resetting React state",
  async () => {
    const harness = await createBrowserHarness(
      cssPageSource(),
      [
        {
          contents: '@import "./theme.css";',
          relativePath: "src/pages/styles.css",
        },
        {
          contents: ".hmr-color { color: rgb(128, 0, 128); }",
          relativePath: "src/pages/theme.css",
        },
      ],
      false
    );
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    await waitForComputedColor(harness.view, "rgb(128, 0, 128)");

    writeAppFile(
      harness.app.path,
      "src/pages/theme.css",
      ".hmr-color { color: rgb(255, 165, 0); }"
    );
    await waitForComputedColor(harness.view, "rgb(255, 165, 0)");

    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  45_000
);

browserTodoTest(
  "a stylesheet is pruned when its component import is removed",
  async () => {
    const harness = await createBrowserHarness(
      cssPageSource(),
      [
        {
          contents: ".hmr-color { color: rgb(255, 165, 0); }",
          relativePath: "src/pages/styles.css",
        },
      ],
      false
    );
    activeHarness = harness;
    await waitForComputedColor(harness.view, "rgb(255, 165, 0)");

    writeAppFile(
      harness.app.path,
      "src/pages/index.tsx",
      cssPageSource().replace('import "./styles.css";\n', "")
    );
    await Bun.sleep(750);

    expect(
      (await harness.view.evaluate(
        "getComputedStyle(document.querySelector('main')).color"
      )) as string
    ).toBe("rgb(0, 0, 0)");
  },
  30_000
);

browserTodoTest(
  "a CSS module edit updates its scoped class without resetting React state",
  async () => {
    const harness = await createBrowserHarness(
      cssModulePageSource(),
      [
        {
          contents: ".color { color: rgb(0, 128, 128); }",
          relativePath: "src/pages/styles.module.css",
        },
      ],
      false
    );
    activeHarness = harness;

    expect(
      (await harness.view.evaluate("Boolean(document.querySelector('main'))")) as boolean
    ).toBe(true);

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await waitForComputedColor(harness.view, "rgb(0, 128, 128)");
    await harness.view.click('[data-testid="increment"]');

    writeAppFile(
      harness.app.path,
      "src/pages/styles.module.css",
      ".color { color: rgb(255, 0, 255); }"
    );

    await waitForComputedColor(harness.view, "rgb(255, 0, 255)");
    const after = await readSnapshot(harness.view);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  30_000
);

browserTest(
  "a component and loader edit converge without resetting React state",
  async () => {
    const harness = await createBrowserHarness(loaderPageSource("combined-v1", false), [], false);
    activeHarness = harness;

    await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    );
    await waitForElementText(harness.view, '[data-testid="loader"]', "loader-combined-v1");
    await harness.view.click('[data-testid="increment"]');
    const before = await readSnapshot(harness.view);

    writeAppFile(harness.app.path, "src/pages/index.tsx", loaderPageSource("combined-v2", false));

    const after = await waitForVersion(harness.view, "combined-v2");
    await waitForElementText(harness.view, '[data-testid="loader"]', "loader-combined-v2");
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(before.documentId);
  },
  30_000
);

browserTest(
  "a rapid save burst converges on the latest edit",
  async () => {
    const harness = await createBrowserHarness(pageSource("burst-v1", false), [], false);
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');

    writeAppFile(harness.app.path, "src/pages/index.tsx", pageSource("burst-v2", false));
    writeAppFile(harness.app.path, "src/pages/index.tsx", pageSource("burst-v3", false));
    writeAppFile(harness.app.path, "src/pages/index.tsx", pageSource("burst-v4", false));

    const after = await waitForVersion(harness.view, "burst-v4");
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  30_000
);

browserTest(
  "a newer loader refresh supersedes an older slow response",
  async () => {
    const harness = await createBrowserHarness(loaderPageSource("race-v1", false), [], false);
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    await waitForElementText(harness.view, '[data-testid="loader"]', "loader-race-v1");

    writeAppFile(harness.app.path, "src/pages/index.tsx", slowLoaderPageSource("race-slow", 1200));
    await waitForVersion(harness.view, "race-slow");
    await Bun.sleep(100);
    writeAppFile(harness.app.path, "src/pages/index.tsx", loaderPageSource("race-fast", false));

    const afterFast = await waitForVersion(harness.view, "race-fast");
    await waitForElementText(harness.view, '[data-testid="loader"]', "loader-race-fast");
    await Bun.sleep(1400);

    expect(
      (await harness.view.evaluate(
        "document.querySelector('[data-testid=\"loader\"]')?.textContent"
      )) as string | undefined
    ).toBe("loader-race-fast");
    expect(afterFast.count).toBe("1");
    expect(afterFast.documentId).toBe(documentId);
  },
  45_000
);

browserTest(
  "SSR, SSG, and ISR routes all refresh component and loader data",
  async () => {
    for (const mode of ["ssr", "ssg", "isr"] as const) {
      const harness = await createBrowserHarness(
        renderingModePageSource(`${mode}-v1`, mode),
        [],
        false
      );
      activeHarness = harness;

      const documentId = (await harness.view.evaluate(
        "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
      )) as string;
      await harness.view.click('[data-testid="increment"]');
      await waitForElementText(harness.view, '[data-testid="loader"]', `loader-${mode}-v1`);

      writeAppFile(
        harness.app.path,
        "src/pages/index.tsx",
        renderingModePageSource(`${mode}-v2`, mode)
      );

      const after = await waitForVersion(harness.view, `${mode}-v2`);
      await waitForElementText(harness.view, '[data-testid="loader"]', `loader-${mode}-v2`);
      expect(after.count).toBe("1");
      expect(after.documentId).toBe(documentId);

      closeBrowserHarness(harness);
      activeHarness = undefined;
    }
  },
  60_000
);

browserTest(
  "a deferred loader refresh resolves the latest value without resetting state",
  async () => {
    const harness = await createBrowserHarness(deferredPageSource("defer-v1"), [], false);
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await waitForElementText(harness.view, '[data-testid="deferred"]', "deferred-defer-v1");
    await harness.view.click('[data-testid="increment"]');

    writeAppFile(harness.app.path, "src/pages/index.tsx", deferredPageSource("defer-v2"));

    const after = await waitForVersion(harness.view, "defer-v2");
    await waitForElementText(harness.view, '[data-testid="deferred"]', "deferred-defer-v2");
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  45_000
);

browserTest(
  "a composite RSC loader value refreshes without resetting client state",
  async () => {
    const harness = await createBrowserHarness(rscPageSource("rsc-v1"), [], false);
    activeHarness = harness;

    const documentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await waitForElementText(harness.view, '[data-testid="rsc-value"]', "rsc-rsc-v1");
    await harness.view.click('[data-testid="increment"]');

    writeAppFile(harness.app.path, "src/pages/index.tsx", rscPageSource("rsc-v2"));

    const after = await waitForVersion(harness.view, "rsc-v2");
    await waitForElementText(harness.view, '[data-testid="rsc-value"]', "rsc-rsc-v2");
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(documentId);
  },
  60_000
);

browserTest(
  "a route added during development becomes available to browser navigation",
  async () => {
    const harness = await createBrowserHarness(topologyHomeSource(), [], false);
    activeHarness = harness;

    writeAppFile(harness.app.path, "src/pages/added.tsx", addedRouteSource("topology-added"));
    await waitForHttpBody(`${harness.url}/added`, "Added route");
    await waitForHmrFrame(harness);
    await waitForStableDocument(harness.view);

    await harness.view.evaluate(
      "(() => { document.querySelector('[data-testid=\"added-link\"]')?.click(); return true; })()"
    );

    const after = await waitForVersion(harness.view, "topology-added");
    expect(after.version).toBe("topology-added");
  },
  45_000
);

browserTest(
  "the active page becomes not-found when its route file is removed",
  async () => {
    const harness = await createBrowserHarness(
      topologyHomeSource(),
      [
        {
          contents: addedRouteSource("topology-removal"),
          relativePath: "src/pages/added.tsx",
        },
      ],
      false
    );
    activeHarness = harness;
    await harness.view.navigate(`${harness.url}/added`);
    await waitForVersion(harness.view, "topology-removal");

    removeAppPath(harness.app.path, "src/pages/added.tsx");
    await waitForHttpStatus(`${harness.url}/added`, 404);

    await waitForBodyText(harness.view, "This page does not exist");
  },
  45_000
);

browserTest(
  "a prefixed instance refreshes without affecting a sibling instance",
  async () => {
    const harness = await createBrowserHarness(
      pageSource("public-v1", false),
      [
        {
          contents: rootSource("admin-root"),
          relativePath: "src/admin-pages/root.tsx",
        },
        {
          contents: pageSource("admin-v1", false),
          relativePath: "src/admin-pages/index.tsx",
        },
        {
          contents: multiInstanceServerSource(),
          relativePath: "src/server.ts",
        },
      ],
      false
    );
    activeHarness = harness;
    const adminView = new Bun.WebView({
      backend: { type: "chrome", url: false },
      height: 720,
      width: 1280,
    });
    harness.extraViews.push(adminView);
    await adminView.navigate(`${harness.url}/admin`);
    await waitForVersion(adminView, "admin-v1");

    const publicDocumentId = (await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    const adminDocumentId = (await adminView.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    )) as string;
    await harness.view.click('[data-testid="increment"]');
    await adminView.click('[data-testid="increment"]');

    writeAppFile(harness.app.path, "src/admin-pages/index.tsx", pageSource("admin-v2", false));

    const adminAfter = await waitForVersion(adminView, "admin-v2");
    const publicAfter = await readSnapshot(harness.view);
    expect(adminAfter.count).toBe("1");
    expect(adminAfter.documentId).toBe(adminDocumentId);
    expect(publicAfter).toEqual({
      count: "1",
      documentId: publicDocumentId,
      version: "public-v1",
    });
  },
  60_000
);

browserTest(
  "measures edit-to-paint after the updated DOM reaches a paint boundary",
  async () => {
    const harness = await createBrowserHarness(paintPageSource("paint-v1", 0), [], false);
    activeHarness = harness;

    await harness.view.evaluate(`(() => {
    window.__furinTestDocumentId = crypto.randomUUID();
    window.__furinHmrPaint = undefined;
    const observer = new MutationObserver(() => {
      const main = document.querySelector('main');
      if (main?.dataset.version !== 'paint-v2') return;
      observer.disconnect();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const paintedAt = performance.timeOrigin + performance.now();
        window.__furinHmrPaint = {
          latencyMs: paintedAt - Number(main.dataset.editedAt),
          paintedAt,
          version: main.dataset.version,
        };
      }));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
    });
  })()`);
    await harness.view.click('[data-testid="increment"]');
    const before = await readSnapshot(harness.view);
    const editedAt = Date.now();

    writeAppFile(harness.app.path, "src/pages/index.tsx", paintPageSource("paint-v2", editedAt));

    const measurement = await waitForPaintMeasurement(harness.view);
    const after = await readSnapshot(harness.view);
    console.info(JSON.stringify({ hmrEditToPaint: measurement }));
    expect(measurement.version).toBe("paint-v2");
    expect(measurement.paintedAt).toBeGreaterThanOrEqual(editedAt);
    expect(measurement.latencyMs).toBeGreaterThanOrEqual(0);
    expect(measurement.latencyMs).toBeLessThan(10_000);
    expect(after.count).toBe("1");
    expect(after.documentId).toBe(before.documentId);
  },
  30_000
);

browserTest(
  "the HMR WebSocket reconnects and recovers without a manual reload",
  async () => {
    const harness = await createBrowserHarness(pageSource("socket-v1", false), [], true);
    activeHarness = harness;

    await waitForWebSocketConnectionCount(harness, 1);
    await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    );
    await harness.view.click('[data-testid="increment"]');
    const before = await readSnapshot(harness.view);
    const connectionCount = harness.webSocketUrls.length;
    const closedCount = harness.webSocketClosed.length;
    const handshakeCount = harness.webSocketHandshakes.length;

    expect(harness.proxy?.dropWebSockets()).toBeGreaterThanOrEqual(1);
    await waitForWebSocketClosedCount(harness, closedCount + 1);
    writeAppFile(harness.app.path, "src/pages/index.tsx", pageSource("socket-offline", false));

    await waitForWebSocketConnectionCount(harness, connectionCount + 1);
    await waitForWebSocketHandshakeCount(harness, handshakeCount + 1);

    const after = await waitForVersion(harness.view, "socket-offline");
    expect(after.count).toBe("0");
    expect(after.documentId).not.toBe(before.documentId);
  },
  45_000
);

browserTest(
  "two tabs recover from repeated HMR WebSocket drops",
  async () => {
    const harness = await createBrowserHarness(pageSource("tabs-v1", false), [], true);
    activeHarness = harness;
    const secondView = new Bun.WebView({
      backend: { type: "chrome", url: false },
      height: 720,
      width: 1280,
    });
    harness.extraViews.push(secondView);
    await secondView.navigate(harness.url);
    await waitForVersion(secondView, "tabs-v1");
    if (!harness.proxy) {
      throw new Error("Expected the HMR transport proxy to be active");
    }
    await waitForProxyWebSocketCount(harness.proxy, 2);

    for (let drop = 1; drop <= 3; drop += 1) {
      const firstDocumentId = (await harness.view.evaluate(
        "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
      )) as string;
      const secondDocumentId = (await secondView.evaluate(
        "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
      )) as string;
      const connectionCount = harness.webSocketUrls.length;

      expect(harness.proxy.dropWebSockets()).toBeGreaterThanOrEqual(2);
      writeAppFile(harness.app.path, "src/pages/index.tsx", pageSource(`tabs-v${drop + 1}`, false));
      await waitForWebSocketConnectionCount(harness, connectionCount + 1);

      const firstAfter = await waitForVersion(harness.view, `tabs-v${drop + 1}`);
      const secondAfter = await waitForVersion(secondView, `tabs-v${drop + 1}`);
      expect(firstAfter.documentId).not.toBe(firstDocumentId);
      expect(secondAfter.documentId).not.toBe(secondDocumentId);
      await waitForProxyWebSocketCount(harness.proxy, 2);
    }
  },
  60_000
);

soakTest(
  `tracks memory across ${soakEditCount.toLocaleString("en-US")} browser edits`,
  async () => {
    const harness = await createBrowserHarness(pageSource("soak-warmup-0", false), [], false);
    activeHarness = harness;

    await harness.view.cdp("HeapProfiler.enable");
    await harness.view.evaluate(
      "(() => { window.__furinTestDocumentId = crypto.randomUUID(); return window.__furinTestDocumentId; })()"
    );
    await harness.view.click('[data-testid="increment"]');
    const before = await readSnapshot(harness.view);

    for (let edit = 1; edit <= 20; edit += 1) {
      writeAppFile(
        harness.app.path,
        "src/pages/index.tsx",
        pageSource(`soak-warmup-${edit}`, false)
      );
      await waitForVersion(harness.view, `soak-warmup-${edit}`);
    }

    const samples: SoakMemorySample[] = [await collectMemorySample(harness, 0)];
    const editDurationsMs: number[] = [];
    const sampleInterval = Math.max(1, Math.floor(soakEditCount / 20));

    for (let edit = 1; edit <= soakEditCount; edit += 1) {
      const version = `soak-${edit}`;
      const startedAt = performance.now();
      writeAppFile(harness.app.path, "src/pages/index.tsx", pageSource(version, false));
      await waitForVersion(harness.view, version);
      editDurationsMs.push(performance.now() - startedAt);

      if (edit % sampleInterval === 0 || edit === soakEditCount) {
        samples.push(await collectMemorySample(harness, edit));
      }
    }

    const after = await readSnapshot(harness.view);
    const [firstSample] = samples;
    const lastSample = samples.at(-1);
    if (!(firstSample && lastSample)) {
      throw new Error("The HMR soak did not collect memory samples");
    }

    const browserHeapGrowthBytes = lastSample.browserHeapBytes - firstSample.browserHeapBytes;
    const serverRssGrowthBytes = lastSample.serverRssBytes - firstSample.serverRssBytes;
    console.info(
      JSON.stringify({
        hmrSoak: {
          browserHeapGrowthBytes,
          edits: soakEditCount,
          p95EditToDomMs: percentile(editDurationsMs, 0.95),
          samples,
          serverRssGrowthBytes,
        },
      })
    );

    expect(after.count).toBe("1");
    expect(after.documentId).toBe(before.documentId);
    expect(browserHeapGrowthBytes).toBeLessThan(64 * 1024 * 1024);
    expect(serverRssGrowthBytes).toBeLessThan(256 * 1024 * 1024);
  },
  3_600_000
);
