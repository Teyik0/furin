import type { AnyElysia } from "elysia";
import { type DesktopEntry, getDesktopState, withDesktopEntry } from "./registry";
import { createSessionGuard } from "./runtime";

const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const FORWARDED = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"];

const ownerKey: unique symbol = Symbol.for("@teyik0/furin-electrobun/web-dev-owner");
const memory = globalThis as typeof globalThis & {
  [ownerKey]?: { session: { name: string; value: string }; origin?: string };
};

/** CLI-only owner bootstrap. Does not install a native runtime or load the SDK. */
export function createWebDevelopment() {
  const owner = (memory[ownerKey] ??= {
    session: {
      name: `furin_web_dev_${crypto.randomUUID().replaceAll("-", "")}`,
      value: crypto.randomUUID(),
    },
  });
  const { session } = owner;
  const path = `/.furin/dev-owner/${crypto.randomUUID()}`;
  let origin = "";
  let spent = false;
  let active = true;
  const issued = Date.now();
  const guard = createSessionGuard(session, () => origin);
  const entry: DesktopEntry = {
    webDevelopment: true,
    mode: "dev",
    runtime: undefined,
    webBootstrap(request, peerAddress) {
      const url = new URL(request.url);
      if (url.pathname !== path) {
        return;
      }
      if (!active || spent || Date.now() - issued > 60_000) {
        return new Response("Gone", { status: 410, headers: { "cache-control": "no-store" } });
      }
      if (
        request.method !== "GET" ||
        url.origin !== origin ||
        url.search !== "" ||
        !peerAddress ||
        !LOOPBACK.test(peerAddress) ||
        FORWARDED.some((name) => request.headers.has(name)) ||
        (request.headers.has("origin") && request.headers.get("origin") !== origin) ||
        request.headers.get("sec-fetch-site") === "cross-site" ||
        (request.headers.has("referer") &&
          !request.headers.get("referer")?.startsWith(`${origin}/`))
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      spent = true;
      return new Response(null, {
        status: 303,
        headers: {
          location: `${origin}/`,
          "set-cookie": `${session.name}=${session.value}; HttpOnly; SameSite=Strict; Path=/${origin.startsWith("https:") ? "; Secure" : ""}`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    },
    guard(request) {
      if (!active || FORWARDED.some((name) => request.headers.has(name))) {
        return new Response("Forbidden", { status: 403 });
      }
      return guard(request);
    },
  };
  return {
    load<T>(load: () => Promise<T>): Promise<T> {
      return withDesktopEntry(entry, load);
    },
    async ready(app: AnyElysia) {
      const state = getDesktopState(app);
      if (!(state && app.server)) {
        return;
      }
      const url = new URL(app.server.url);
      if (url.hostname === "0.0.0.0") {
        url.hostname = "127.0.0.1";
      } else if (url.hostname === "[::]") {
        url.hostname = "[::1]";
      }
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        throw new Error(
          "Web development owner bootstrap requires a loopback or wildcard listener."
        );
      }
      ({ origin } = url);
      await state.ready?.();
      if (owner.origin === origin) {
        return;
      }
      // Pass the single-use capability directly to the OS browser, never to logs or disk.
      const destination = `${origin}${path}`;
      let command = ["xdg-open", destination];
      if (process.platform === "darwin") {
        command = ["open", destination];
      } else if (process.platform === "win32") {
        command = ["rundll32", "url.dll,FileProtocolHandler", destination];
      }
      try {
        const browser = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
        if ((await browser.exited) !== 0) {
          throw new Error("Browser launch failed");
        }
      } catch {
        // biome-ignore lint/style/useErrorCause: OS spawn errors can expose the private bootstrap token.
        throw new Error("Could not open the web development owner session in the system browser.");
      }
      owner.origin = origin;
    },
    stop() {
      active = false;
      return Promise.resolve();
    },
  };
}
