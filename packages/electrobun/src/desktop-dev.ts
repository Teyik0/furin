import { existsSync, readFileSync, watch } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { AnyElysia } from "elysia";
import type { DesktopAppOptions } from "./capabilities";
import { backendDependencies, type DesktopDevelopmentSettings } from "./cli";
import { createDesktopContext, type DesktopCommand } from "./commands";
import { redeemWindowUrl } from "./dev-bootstrap";
import { type ChannelPeer, createChannelPeer } from "./dev-channel";
import {
  type DesktopEntry,
  getDesktopState,
  setDesktopContext,
  withDesktopEntry,
} from "./registry";
import { createSessionGuard, desktopOrigin } from "./runtime";

/** Messages the native shell sends to the hot backend. */
export type ShellRequest = { type: "backend" } | { type: "background" } | { type: "restart" };

export interface BackendInfo {
  key: string;
  openBrowser: boolean;
  origin: string;
  window: DesktopAppOptions["window"];
}

interface Owner {
  channel: { url: string };
  hooks: DesktopAppOptions | undefined;
  key: string;
  launches: number;
  launching: Promise<void> | undefined;
  origin: string;
  peer: ChannelPeer | undefined;
  restart: boolean;
  session: { name: string; value: string };
  settings: DesktopDevelopmentSettings;
  shell: Bun.Subprocess | undefined;
  socket: unknown;
  spent: Map<string, number>;
}

// Bun --hot re-evaluates this module but keeps globalThis: the shell and channel survive reloads.
const ownerKey: unique symbol = Symbol.for("@teyik0/furin-electrobun/desktop-dev-owner");
const memory = globalThis as typeof globalThis & { [ownerKey]?: Owner };

function readSettings(): DesktopDevelopmentSettings {
  const path = process.env.FURIN_DESKTOP_DEV;
  if (!path) {
    throw new Error("Desktop development settings are missing; run furin dev.");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function handleShell(owner: Owner, request: ShellRequest): unknown {
  switch (request.type) {
    case "backend":
      return {
        key: owner.key,
        openBrowser: owner.launches === 1,
        origin: owner.origin,
        window: owner.hooks?.window,
      } satisfies BackendInfo;
    case "background":
      return owner.hooks?.background?.() ?? false;
    case "restart":
      owner.restart = true;
      return;
    default:
      throw new Error("Unknown shell request.");
  }
}

function openChannel(owner: Owner) {
  const token = crypto.randomUUID();
  const server = Bun.serve<undefined>({
    // Under --hot, Bun reloads id-less servers in place: the app's listener would replace this one.
    id: "@teyik0/furin-electrobun/desktop-channel",
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bun) {
      if (new URL(request.url).searchParams.get("token") !== token) {
        return new Response("Forbidden", { status: 403 });
      }
      return bun.upgrade(request) ? undefined : new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      open(socket) {
        owner.peer?.close("Desktop shell was replaced.");
        owner.socket = socket;
        owner.peer = createChannelPeer(
          (data) => socket.send(data),
          async (body) => handleShell(owner, body as ShellRequest)
        );
      },
      message(socket, data) {
        if (socket === owner.socket) {
          owner.peer?.receive(String(data));
        }
      },
      close(socket) {
        if (socket === owner.socket) {
          owner.peer?.close("Desktop shell disconnected.");
          owner.peer = undefined;
          owner.socket = undefined;
        }
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/?token=${token}` };
}

async function launchShell(owner: Owner): Promise<void> {
  const { channel, settings } = owner;
  const bunfig = join(settings.root, "bunfig.toml");
  const env = {
    ...process.env,
    FURIN_DESKTOP_CHANNEL: JSON.stringify(channel),
    BUN_OPTIONS:
      `${process.env.BUN_OPTIONS ?? ""} ${existsSync(bunfig) ? JSON.stringify(`--config=${bunfig}`) : ""}`.trim(),
  };
  const build = Bun.spawn([process.execPath, settings.sdk, "build", "--env=dev"], {
    cwd: settings.generated,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) {
    console.error("[furin-electrobun] Desktop shell build failed; waiting for native changes.");
    return;
  }
  owner.launches += 1;
  const shell = Bun.spawn([process.execPath, settings.sdk, "run", "--env=dev"], {
    cwd: settings.generated,
    env,
    stdout: "inherit",
    stderr: "inherit",
    // Its own process group: Ctrl-C reaches the backend, which then closes the channel.
    detached: process.platform !== "win32",
  });
  owner.shell = shell;
  shell.exited
    .then(() => {
      owner.shell = undefined;
      if (!owner.restart) {
        // Quitting the desktop app ends the development session, as a packaged app would.
        process.kill(process.pid, "SIGINT");
        return;
      }
      owner.restart = false;
      return launchShell(owner);
    })
    .catch(console.error);
}

/** Relaunches only the shell when its native import graph changes; the backend stays hot. */
async function watchNative(owner: Owner) {
  const { settings } = owner;
  if (!settings.nativeEntry) {
    return;
  }
  const root = await realpath(settings.root);
  const entry = join(root, settings.nativeEntry);
  const scan = async () =>
    (await backendDependencies(root, [entry], settings.sdkAliases, settings.nativeAliases)) ??
    new Set([entry]);
  let graph = await scan();
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(root, { recursive: true }, (_event, filename) => {
    if (!(filename && graph.has(join(root, filename)))) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(async () => {
      graph = await scan();
      if (!owner.shell) {
        // The previous shell build failed: this native edit may have repaired it.
        launchShell(owner).catch(console.error);
        return;
      }
      owner.restart = true;
      owner.peer?.request({ type: "quit" } satisfies DesktopCommand).catch(() => undefined);
    }, 150);
  });
}

function startOwner(settings: DesktopDevelopmentSettings): Owner {
  const owner: Owner = {
    channel: { url: "" },
    hooks: undefined,
    key: crypto.randomUUID(),
    launches: 0,
    launching: undefined,
    origin: "",
    peer: undefined,
    restart: false,
    session: {
      name: `furin_desktop_${crypto.randomUUID().replaceAll("-", "")}`,
      value: crypto.randomUUID(),
    },
    settings,
    shell: undefined,
    socket: undefined,
    spent: new Map<string, number>(),
  };
  owner.channel = openChannel(owner);
  watchNative(owner).catch(console.error);
  return owner;
}

/** Hot backend integration loaded by Furin's development worker for desktop projects. */
export function createDevelopment() {
  const settings = readSettings();
  const owner = (memory[ownerKey] ??= startOwner(settings));
  const context = createDesktopContext((command) =>
    owner.peer
      ? owner.peer.request(command)
      : Promise.reject(new Error("Desktop shell is not connected."))
  );
  setDesktopContext(context);
  process.env.FURIN_APP_DATA_DIR = settings.dataDir;
  const guard = createSessionGuard(owner.session, () => owner.origin);
  const entry: DesktopEntry = {
    mode: "dev",
    runtime: {
      kind: "desktop",
      desktop: context,
      identity: { ...settings.config.app, channel: "dev" },
    },
    guard,
    webBootstrap: (request, peerAddress) =>
      redeemWindowUrl(owner.key, owner.spent, owner.session, owner.origin, request, peerAddress),
  };
  return {
    async load<T>(load: () => Promise<T>): Promise<T> {
      await mkdir(settings.dataDir, { recursive: true });
      return withDesktopEntry(entry, load);
    },
    async ready(app: AnyElysia) {
      const state = getDesktopState(app);
      if (!(state && app.server)) {
        throw new Error(
          'Desktop root must use desktopApp() from "@teyik0/furin-electrobun/server" before listening.'
        );
      }
      const origin = desktopOrigin(app.server.url);
      if (owner.origin && owner.origin !== origin && owner.shell) {
        // A new port (e.g. port 0) orphans open windows: relaunch the shell on the new origin.
        owner.restart = true;
        owner.peer?.request({ type: "quit" } satisfies DesktopCommand).catch(() => undefined);
      }
      owner.origin = origin;
      owner.hooks = state.hooks;
      await state.ready?.();
      // Not awaited: a first SDK build can outlast the worker's startup budget.
      owner.launching ??= launchShell(owner).catch((error: unknown) => {
        console.error("[furin-electrobun] Desktop shell launch failed:", error);
      });
    },
    // Hot reloads stop the old application only; the shell keeps its windows.
    stop: () => Promise.resolve(),
  };
}
