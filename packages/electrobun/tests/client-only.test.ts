import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopSdk } from "../src/native-sdk";
import { runStandardDesktopHost } from "../src/standard-host";

test("client-only host keeps the manager and lifecycle without importing a backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-client-only-"));
  const identity = {
    identifier: "local.furin.client",
    name: "Client",
    channel: "dev",
    version: "1.0.0",
  };
  let loaded = false;
  let managed = false;
  let managers = 0;
  const events = new Map<string, (event: unknown) => void>();
  let code: number | undefined;
  const sdk = {
    default: {
      events: {
        on(name: string, handler: (event: unknown) => void) {
          events.set(name, handler);
        },
        off() {
          /* No external listeners are installed in this SDK fixture. */
        },
      },
    },
    Updater: {
      getLocalInfo() {
        return Promise.resolve(identity);
      },
      onStatusChange() {
        /* Updates are idle in this fixture. */
      },
    },
    Utils: {
      paths: { appData: root },
      quit(value: number) {
        code = value;
      },
    },
    BrowserView: { getAll: () => [] },
    ApplicationMenu: {
      setApplicationMenu() {
        /* No OS menu in the SDK fixture. */
      },
      on() {
        /* No OS menu events. */
      },
    },
  } as unknown as DesktopSdk;
  try {
    const host = await runStandardDesktopHost(sdk, {
      config: { app: identity, window: { width: 800, height: 600 } },
      root,
      dataDir: root,
      mode: "build",
      startServer: false,
      load() {
        loaded = true;
        return Promise.reject(new Error("Backend must remain absent"));
      },
      manager({ backend }) {
        managed = true;
        managers += 1;
        expect(backend).toBeUndefined();
      },
    });
    expect(managed).toBe(true);
    expect(loaded).toBe(false);
    expect(host?.snapshot().phase).toBe("ready");
    events.get("reopen")?.({});
    expect(managers).toBe(2);
    await host?.quit();
    expect(code).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
