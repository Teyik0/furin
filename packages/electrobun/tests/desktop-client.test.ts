/// <reference lib="dom" />

import { afterEach, beforeEach, expect, expectTypeOf, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OpenBrowserResult, useDesktop } from "@teyik0/furin-electrobun/client";
import { Elysia } from "elysia";
import { act, createElement } from "react";
import { renderDom, useDomTests as setupDomTests } from "../../core/tests/support/dom";
import type { DesktopSdk } from "../src/native-sdk";
import { desktopApp } from "../src/server";
import { runStandardDesktopHost } from "../src/standard-host";
import { installSdk } from "./fixtures/sdk";

type BridgeWindow = Window & { __electrobunSendToHost?: (message: unknown) => void };
const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

setupDomTests();
beforeEach(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = undefined;
});

async function renderClient() {
  let desktop!: ReturnType<typeof useDesktop>;
  let rendered!: ReturnType<typeof renderDom>;
  function Probe() {
    desktop = useDesktop();
    return createElement("span", null, desktop.status);
  }
  await act(async () => {
    rendered = renderDom(createElement(Probe));
    await Promise.resolve();
  });
  return {
    get desktop() {
      return desktop;
    },
    rendered,
    cleanup: () => act(() => rendered.cleanup()),
  };
}

async function withDesktop(
  run: (fixture: {
    sdk: DesktopSdk;
    native: NonNullable<NonNullable<Awaited<ReturnType<typeof runStandardDesktopHost>>>["window"]>;
    origin: string;
    bootstrap: string;
    opened: string[];
  }) => void | Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), "furin-react-desktop-"));
  const identity = { name: "Fixture", identifier: "local.furin.react", version: "1.0.0" };
  const previous = process.env.FURIN_APP_DATA_DIR;
  let host: Awaited<ReturnType<typeof runStandardDesktopHost>>;
  try {
    await Bun.write(join(root, ".furin/electrobun/host.json"), JSON.stringify({ app: identity }));
    await installSdk(root);
    const sdk = (await import(join(root, "node_modules/electrobun/main.ts"))) as DesktopSdk;
    Object.defineProperty(sdk.Utils, "quit", { value: () => true });
    host = await runStandardDesktopHost(sdk, {
      config: { app: identity },
      dataDir: join(root, "data"),
      root,
      mode: "build",
      load: async () => ({ default: new Elysia().use(desktopApp({ background: () => true })) }),
    });
    const native = host?.window;
    if (!native) {
      throw new Error("Missing native window");
    }
    const { options } = native as typeof native & { options: { sandbox: boolean; url: string } };
    expect(options.sandbox).toBe(true);
    const response = await fetch(options.url, { redirect: "manual" });
    const page = new URL(response.headers.get("location") ?? "");
    Object.defineProperty(window, "location", {
      value: new URL(`${page.origin}/settings/updates`),
    });
    (window as BridgeWindow).__electrobunSendToHost = (message) => {
      sdk.default.events.emitEvent(
        sdk.default.events.events.webview.hostMessage({ detail: JSON.stringify(message) }),
        native.webviewId
      );
    };
    native.webview.executeJavascript = (script) => {
      new Function("window", "CustomEvent", script)(window, window.CustomEvent);
    };
    const opened: string[] = [];
    Object.defineProperty(sdk.Utils, "openExternal", {
      value: (url: string) => {
        opened.push(url);
        return true;
      },
    });
    await run({ sdk, native, origin: page.origin, bootstrap: options.url, opened });
  } finally {
    (window as BridgeWindow).__electrobunSendToHost = undefined;
    await host?.quit();
    if (previous === undefined) {
      delete process.env.FURIN_APP_DATA_DIR;
    } else {
      process.env.FURIN_APP_DATA_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("the public client imports and renders a regular link without window during SSR", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { createElement } from "react";
    import { renderToString } from "react-dom/server";
    Object.defineProperty(globalThis, "window", { get() { throw new Error("SSR accessed window"); } });
    const { useDesktop } = await import("@teyik0/furin-electrobun/client");
    function Download() {
      const desktop = useDesktop();
      return createElement("a", { href: "/api/updates/download" }, desktop.status);
    }
    console.log(renderToString(createElement(Download)));
  `,
    ],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" }
  );
  const [code, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, errors).toBe(0);
  expect(output.trim()).toBe('<a href="/api/updates/download">initializing</a>');
});

test("a browser without a native bridge cannot invoke a host, even when one exists", async () => {
  await withDesktop(async ({ opened }) => {
    (window as BridgeWindow).__electrobunSendToHost = undefined;
    const client = await renderClient();
    try {
      expect(client.desktop.status).toBe("web");
      expect(await client.desktop.browser.open("/api/updates/download")).toEqual({
        ok: false,
        reason: "unavailable",
      });
      expect(opened).toEqual([]);
    } finally {
      client.cleanup();
    }
  });
});

test("a sandboxed desktop opens relative and external URLs with native acknowledgement", async () => {
  await withDesktop(async ({ origin, opened }) => {
    const client = await renderClient();
    try {
      expect(client.desktop.status).toBe("desktop");
      expectTypeOf(client.desktop.browser.open).returns.toEqualTypeOf<Promise<OpenBrowserResult>>();
      expect(await client.desktop.browser.open("../api/updates/download")).toEqual({ ok: true });
      expect(
        await client.desktop.browser.open("https://downloads.example.test/update.zip")
      ).toEqual({ ok: true });
      expect(opened).toEqual([
        `${origin}/api/updates/download`,
        "https://downloads.example.test/update.zip",
      ]);
    } finally {
      client.cleanup();
    }
  });
});

test("a false native result or a thrown opener error is reported as an opening failure", async () => {
  await withDesktop(async ({ sdk }) => {
    const client = await renderClient();
    try {
      Object.defineProperty(sdk.Utils, "openExternal", { value: () => false });
      expect(await client.desktop.browser.open("https://example.test")).toEqual({
        ok: false,
        reason: "open-failed",
      });
      Object.defineProperty(sdk.Utils, "openExternal", {
        value: () => {
          throw new Error("No browser");
        },
      });
      expect(await client.desktop.browser.open("https://example.test")).toEqual({
        ok: false,
        reason: "open-failed",
      });
    } finally {
      client.cleanup();
    }
  });
});

test("dangerous URLs, embedded credentials and private bootstrap URLs are refused", async () => {
  await withDesktop(async ({ bootstrap, opened }) => {
    const client = await renderClient();
    try {
      for (const url of [
        "javascript:alert(1)",
        "file:///private",
        "data:text/html,test",
        "https://user:secret@example.test",
        bootstrap,
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: Verify each refused URL returns a typed failure.
        expect(await client.desktop.browser.open(url)).toEqual({
          ok: false,
          reason: "invalid-url",
        });
      }
      expect(opened).toEqual([]);
    } finally {
      client.cleanup();
    }
  });
});

test("the host validates raw bridge commands independently of the React client", async () => {
  await withDesktop(({ opened }) => {
    const send = (window as BridgeWindow).__electrobunSendToHost;
    send?.({
      type: "furin:desktop",
      id: "forged",
      command: "open-browser",
      url: "javascript:alert(1)",
    });
    send?.({ type: "furin:desktop", id: "relative", command: "open-browser", url: "/private" });
    send?.({ type: "furin:desktop", id: "malformed", command: "open-browser", url: {} });
    expect(opened).toEqual([]);
  });
});

test("unmount settles pending requests and removes their listeners and timers", async () => {
  await withDesktop(async () => {
    const client = await renderClient();
    (window as BridgeWindow).__electrobunSendToHost = () => {
      /* A present bridge whose host never replies. */
    };
    const { open } = client.desktop.browser;
    const pending = open("https://example.test");
    client.cleanup();
    expect(await pending).toEqual({ ok: false, reason: "unavailable" });
    expect(await open("https://example.test")).toEqual({ ok: false, reason: "unavailable" });
  });
});

test("closing a native window removes its capability listener and cannot acknowledge later requests", async () => {
  await withDesktop(async ({ sdk, native, opened }) => {
    const client = await renderClient();
    const event = `host-message-${native.webviewId}`;
    try {
      expect(sdk.default.events.listenerCount(event)).toBe(1);
      native.close();
      expect(sdk.default.events.listenerCount(event)).toBe(0);
      const pending = client.desktop.browser.open("https://example.test");
      client.cleanup();
      expect(await pending).toEqual({ ok: false, reason: "unavailable" });
      expect(opened).toEqual([]);
    } finally {
      client.cleanup();
    }
  });
});

test("an unresponsive bridge stays initializing until the handshake fails", async () => {
  (window as BridgeWindow).__electrobunSendToHost = () => {
    /* A present bridge whose host never replies. */
  };
  let client: Awaited<ReturnType<typeof renderClient>> | undefined;
  try {
    client = await renderClient();
    expect(client.desktop.status).toBe("initializing");
    await act(async () => {
      await Bun.sleep(5100);
    });
    expect(client.desktop.status).toBe("unavailable");
  } finally {
    client?.cleanup();
    (window as BridgeWindow).__electrobunSendToHost = undefined;
  }
}, 10_000);
