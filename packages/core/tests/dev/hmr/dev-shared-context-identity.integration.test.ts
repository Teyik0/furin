// biome-ignore-all lint/performance/noAwaitInLoops: integration test polling must wait between retries
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { pollUntil, waitForHttp } from "../../support/http.ts";
import { startProcess } from "../../support/process.ts";

/**
 * An unchanged module keeps one ESM identity across HMR edits: a React context
 * created in a shared module is the same object for the root layout providing
 * it and a nested layout consuming it, whichever route file was edited.
 */
function pageSource(version: string): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { Table } from "./table";',
    "",
    'export const route = defineRoute("/dashboard")',
    '  .config({ mode: "ssr" })',
    `  .page(() => <main>page-${version}<Table /></main>);`,
  ].join("\n");
}

function layoutSource(version: string): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    'import { Sidebar } from "../../components/sidebar";',
    'export const route = defineRoute("/dashboard")',
    '  .config({ mode: "ssr" })',
    "  .loader(() => ({ user: 'ada' }))",
    `  .layout(({ children }) => <section data-layout="${version}"><Sidebar />{children}</section>);`,
  ].join("\n");
}

function sidebarSource(version: string): string {
  return [
    'import { useTheme } from "./theme";',
    "export function Sidebar() {",
    `  return <nav data-sidebar="sidebar-${version}">{\`theme-\${useTheme()}\`}</nav>;`,
    "}",
  ].join("\n");
}

function tableSource(version: string): string {
  return [
    'import { useTheme } from "../../components/theme";',
    "",
    "export function Table() {",
    `  return <table data-table="${version}" data-theme={useTheme()} />;`,
    "}",
  ].join("\n");
}

describe.serial("dev shared module identity across HMR edits", () => {
  const app = createTmpApp("cli-app");
  let port: number;
  let server: ReturnType<typeof startProcess>;

  writeAppFile(
    app.path,
    "src/components/theme.tsx",
    [
      'import { createContext, type ReactNode, useContext } from "react";',
      "",
      "const ThemeContext = createContext<string | null>(null);",
      "",
      "export function ThemeProvider({ children }: { children: ReactNode }) {",
      '  return <ThemeContext.Provider value="dark">{children}</ThemeContext.Provider>;',
      "}",
      "",
      "export function useTheme(): string {",
      "  const theme = useContext(ThemeContext);",
      "  if (theme === null) {",
      '    throw new Error("useTheme must be used inside ThemeProvider");',
      "  }",
      "  return theme;",
      "}",
    ].join("\n")
  );
  writeAppFile(app.path, "src/components/sidebar.tsx", sidebarSource("v1"));
  writeAppFile(
    app.path,
    "src/pages/__root.tsx",
    [
      'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";',
      'import { ThemeProvider } from "../components/theme";',
      "export const route = defineRootRoute()",
      '  .config({ mode: "ssg" })',
      "  .layout(({ children }) => (",
      '    <html lang="en">',
      "      <head><HeadContent /></head>",
      "      <body><ThemeProvider>{children}</ThemeProvider><Scripts /></body>",
      "    </html>",
      "  ));",
    ].join("\n")
  );
  writeAppFile(app.path, "src/pages/dashboard/route.tsx", layoutSource("v1"));
  writeAppFile(app.path, "src/pages/dashboard/index.tsx", pageSource("v1"));
  writeAppFile(app.path, "src/pages/dashboard/table.tsx", tableSource("v1"));

  const url = (): string => `http://localhost:${port}/dashboard`;

  async function htmlAfterEdit(marker: string): Promise<string> {
    let html = "";
    await pollUntil(
      async () => {
        html = await (await fetch(url())).text();
        return html.includes(marker);
      },
      60,
      250
    );
    return html;
  }

  beforeAll(async () => {
    port = await getFreePort();
    server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
      cwd: app.path,
      env: { PORT: String(port) },
    });
    await waitForHttp(url(), { timeoutMs: 20_000 }).catch((error) => {
      throw new Error(`${error}\nstderr:\n${server.getStderr()}`);
    });
  }, 30_000);

  afterAll(async () => {
    server?.kill();
    await server?.exitCode;
    app.cleanup();
  });

  test("the nested consumer reads the root provider's context", async () => {
    const html = await (await fetch(url())).text();

    expect(html).toContain("theme-dark");
    expect(html).toContain("page-v1");
  });

  test("editing the page keeps one context identity", async () => {
    writeAppFile(app.path, "src/pages/dashboard/index.tsx", pageSource("v2"));

    const html = await htmlAfterEdit("page-v2");

    expect(html, server.getStderr()).toContain("page-v2");
    expect(html).toContain("theme-dark");
  }, 20_000);

  test("editing the consuming layout keeps one context identity", async () => {
    writeAppFile(app.path, "src/pages/dashboard/route.tsx", layoutSource("v2"));

    const html = await htmlAfterEdit('data-layout="v2"');

    expect(html, server.getStderr()).toContain('data-layout="v2"');
    expect(html).toContain("theme-dark");
  }, 20_000);

  test("repeated edits keep one context identity", async () => {
    writeAppFile(app.path, "src/pages/dashboard/index.tsx", pageSource("v3"));
    await htmlAfterEdit("page-v3");
    writeAppFile(app.path, "src/pages/dashboard/route.tsx", layoutSource("v3"));

    const html = await htmlAfterEdit('data-layout="v3"');

    expect(html, server.getStderr()).toContain('data-layout="v3"');
    expect(html).toContain("theme-dark");
  }, 20_000);

  test("adding a page keeps one context identity", async () => {
    writeAppFile(
      app.path,
      "src/pages/dashboard/settings.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        "",
        'export const route = defineRoute("/dashboard/settings")',
        '  .config({ mode: "ssr" })',
        "  .page(() => <main>settings</main>);",
      ].join("\n")
    );
    let settings = "";
    const added = await pollUntil(
      async () => {
        settings = await (await fetch(`http://localhost:${port}/dashboard/settings`)).text();
        return settings.includes("settings</main>");
      },
      60,
      250
    );
    writeAppFile(app.path, "src/pages/dashboard/index.tsx", pageSource("v4"));

    const html = await htmlAfterEdit("page-v4");

    expect(added, server.getStderr()).toBe(true);
    expect(settings).toContain("theme-dark");
    expect(html).toContain("page-v4");
    expect(html).toContain("theme-dark");
  }, 30_000);

  test("editing a component imported by the page keeps one context identity", async () => {
    writeAppFile(app.path, "src/pages/dashboard/table.tsx", tableSource("v2"));

    const html = await htmlAfterEdit('data-table="v2"');

    expect(html, server.getStderr()).toContain('data-table="v2"');
    expect(html).toContain("theme-dark");
  }, 20_000);

  test("editing a component imported by the layout keeps one context identity", async () => {
    writeAppFile(app.path, "src/components/sidebar.tsx", sidebarSource("v2"));

    const html = await htmlAfterEdit("sidebar-v2");

    expect(html, server.getStderr()).toContain("sidebar-v2");
    expect(html).toContain("theme-dark");
  }, 20_000);
});
