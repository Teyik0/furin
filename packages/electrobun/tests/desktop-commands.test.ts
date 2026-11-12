import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { Elysia } from "elysia";
import { defineNative, getDesktopHost } from "../src/host";
import type { DesktopSdk } from "../src/native-sdk";
import { desktopApp, desktopContext } from "../src/server";
import { runStandardDesktopHost } from "../src/standard-host";
import { installSdk } from "./fixtures/sdk";

const native = defineNative({
  greet: async (name: string) => ({ message: `Hello ${name}` }),
});

test("routes drive native windows and native commands through the async desktop context", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-commands-"));
  const identity = { name: "Fixture", identifier: "local.furin.commands", version: "1.0.0" };
  const api = new Elysia()
    .use(desktopContext)
    .post("/minimize", async ({ desktop }) => {
      await desktop?.window.minimize();
      return { minimized: await desktop?.window.isMinimized() };
    })
    .post("/greet", async ({ desktop }) => {
      const commands = desktop?.native as typeof native | undefined;
      return await commands?.greet("Relay");
    })
    .post("/options", async ({ desktop }) => {
      const options = await desktop?.windows.create("options", { path: "/", title: "Options" });
      await options?.close();
      return { closed: true };
    })
    .post("/closed", async ({ desktop }) => {
      try {
        await desktop?.windows.get("missing").minimize();
        return { rejected: false };
      } catch {
        return { rejected: true };
      }
    });
  const app = new Elysia().use(desktopApp({ window: { title: "Main" } })).use(api);
  let host: Awaited<ReturnType<typeof runStandardDesktopHost>>;
  try {
    await Bun.write(join(root, ".furin/electrobun/host.json"), JSON.stringify({ app: identity }));
    await installSdk(root);
    const sdk = (await import(join(root, "node_modules/electrobun/main.ts"))) as DesktopSdk;
    Object.defineProperty(sdk.Utils, "quit", { value: () => true });
    host = await runStandardDesktopHost(
      sdk,
      {
        config: { app: identity },
        dataDir: join(root, "data"),
        root,
        mode: "build",
        load: async () => ({ default: app }),
      },
      async () => ({ default: native })
    );
    const client = treaty(app);
    expect((await client.minimize.post()).data).toEqual({ minimized: true });
    expect(getDesktopHost()?.window).toBeInstanceOf(sdk.BrowserWindow);
    expect((await client.greet.post()).data).toEqual({ message: "Hello Relay" });
    expect((await client.options.post()).data).toEqual({ closed: true });
    expect(getDesktopHost()?.windows.get("options")).toBeUndefined();
    expect((await client.closed.post()).data).toEqual({ rejected: true });
  } finally {
    await getDesktopHost()?.quit();
    await rm(root, { recursive: true, force: true });
  }
  expect(host).toBeDefined();
});
