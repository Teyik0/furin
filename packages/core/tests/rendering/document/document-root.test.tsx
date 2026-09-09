import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { createTmpApp, type TmpApp, writeAppFile } from "../../support/app-fixtures.ts";

const { furin } = await import("../../../src/furin.ts");
const { __resetCompileContext } = await import("../../../src/server/internal.ts");
const { resetFurinLoggerForTests } = await import("../../../src/server/logger.ts");
const { __setDevMode, IS_DEV } = await import("../../../src/server/runtime-env.ts");

(globalThis as typeof globalThis & { __FURIN_SKIP_DOM_RESET?: boolean }).__FURIN_SKIP_DOM_RESET =
  true;

const originalCwd = process.cwd();
const originalDevMode = IS_DEV;
const tmpApps: TmpApp[] = [];

interface DocumentSourceOptions {
  errorSource: string | undefined;
  pageSource: string;
  rootSource: string;
}

function rootSource(layout: string): string {
  return `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(${layout});
`;
}

function pageSource(component: string, head: string | undefined): string {
  const headStep = head === undefined ? "" : `\n  .head(${head})`;
  return `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(() => ({}))${headStep}
  .page(() => (${component}));
`;
}

async function createDocumentApp(options: DocumentSourceOptions): Promise<Elysia> {
  const fixture = createTmpApp("cli-app");
  tmpApps.push(fixture);
  process.chdir(fixture.path);
  writeAppFile(fixture.path, "src/pages/root.tsx", options.rootSource);
  writeAppFile(fixture.path, "src/pages/index.tsx", options.pageSource);
  if (options.errorSource !== undefined) {
    writeAppFile(fixture.path, "src/pages/error.tsx", options.errorSource);
  }
  return new Elysia().use(await furin({ pagesDir: join(fixture.path, "src/pages") }));
}

function resetState(): void {
  process.chdir(originalCwd);
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
  __resetCompileContext();
  resetFurinLoggerForTests();
}

beforeEach(() => {
  resetState();
  __setDevMode(true);
});

afterEach(resetState);

afterAll(() => {
  __setDevMode(originalDevMode);
});

test.serial("the root layout owns the rendered document", async () => {
  const app = await createDocumentApp({
    errorSource: undefined,
    pageSource: pageSource(
      "<main>Rendered once</main>",
      '() => ({ meta: [{ title: "Document route" }] })'
    ),
    rootSource: rootSource(`({ children }) => (
    <html className="theme" lang="fr">
      <head><HeadContent /></head>
      <body data-shell="application">{children}<Scripts /></body>
    </html>
  )`),
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
  expect(html.match(/<html/g)).toHaveLength(1);
  expect(html.match(/<body/g)).toHaveLength(1);
  expect(html).toContain('<html class="theme" lang="fr">');
  expect(html).toContain('<body data-shell="application">');
  expect(html).toContain("<title>Document route</title>");
  expect(html).toContain("<main>Rendered once</main>");
  expect(html).not.toContain('id="root"');
});

test.serial("the root layout owns the not-found document", async () => {
  const app = await createDocumentApp({
    errorSource: undefined,
    pageSource: pageSource("<main>Home</main>", undefined),
    rootSource: rootSource(`({ children }) => (
    <html lang="fr">
      <head><HeadContent /></head>
      <body data-shell="not-found">{children}<Scripts /></body>
    </html>
  )`),
  });

  const response = await app.handle(new Request("http://localhost/missing"));
  const html = await response.text();

  expect(response.status).toBe(404);
  expect(html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
  expect(html.match(/<html/g)).toHaveLength(1);
  expect(html).toContain('<body data-shell="not-found">');
  expect(html).toContain('id="__FURIN_DATA__"');
});

test.serial("a broken root layout falls back to a complete document", async () => {
  const app = await createDocumentApp({
    errorSource: `export default function RootError({ error }: { error: Error }) {
  return <main data-fallback="root">{error.message}</main>;
}
`,
    pageSource: pageSource("<main>unreachable</main>", undefined),
    rootSource: rootSource(`() => {
    throw new Error("root layout failed");
  }`),
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
  expect(html.match(/<html/g)).toHaveLength(1);
  expect(html.match(/<body/g)).toHaveLength(1);
  expect(html).toContain('<main data-fallback="root">');
  expect(html).toContain('id="__FURIN_DATA__"');
});

test.serial("a head failure is rendered inside the root document", async () => {
  const app = await createDocumentApp({
    errorSource: undefined,
    pageSource: pageSource(
      "<main>unreachable</main>",
      `() => {
    throw new Error("head failed");
  }`
    ),
    rootSource: rootSource(`({ children }) => (
    <html lang="en">
      <head><HeadContent /></head>
      <body>{children}<Scripts /></body>
    </html>
  )`),
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
  expect(html).toContain("Something went wrong");
  expect(html).toContain('id="__FURIN_DATA__"');
});

test.serial("a root layout that does not render html is rejected as a document", async () => {
  const app = await createDocumentApp({
    errorSource: undefined,
    pageSource: pageSource("<p>invalid document content</p>", undefined),
    rootSource: rootSource('({ children }) => <main data-invalid-root="">{children}</main>'),
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
  expect(html).toContain("Something went wrong");
  expect(html).not.toContain("data-invalid-root");
});

test.serial("a root document without Scripts is rejected", async () => {
  const app = await createDocumentApp({
    errorSource: undefined,
    pageSource: pageSource("<p>missing scripts</p>", undefined),
    rootSource: rootSource(`({ children }) => (
    <html lang="en">
      <head><HeadContent /></head>
      <body>{children}</body>
    </html>
  )`),
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(html).toContain("Something went wrong");
  expect(html).not.toContain("missing scripts");
});

test.serial("a root document without HeadContent is rejected", async () => {
  const app = await createDocumentApp({
    errorSource: undefined,
    pageSource: pageSource("<p>missing head content</p>", undefined),
    rootSource: rootSource(`({ children }) => (
    <html lang="en">
      <head />
      <body>{children}<Scripts /></body>
    </html>
  )`),
  });

  const response = await app.handle(new Request("http://localhost/"));
  const html = await response.text();

  expect(response.status).toBe(500);
  expect(html).toContain("Something went wrong");
  expect(html).not.toContain("missing head content");
});
