import type { OpenEvent } from "./capabilities";
import type { DesktopDevelopmentSettings } from "./cli";
import type { DesktopCommand } from "./commands";
import type { BackendInfo, ShellRequest } from "./desktop-dev";
import { mintWindowUrl } from "./dev-bootstrap";
import { createChannelPeer } from "./dev-channel";
import type { DesktopBackend } from "./runtime";

/** Native shell side of a development session; the backend runs in Furin's hot worker. */
export async function getDesktopDevelopment() {
  const path = process.env.FURIN_DESKTOP_DEV;
  const channel = process.env.FURIN_DESKTOP_CHANNEL;
  if (!(path && channel)) {
    return;
  }
  const settings: DesktopDevelopmentSettings = await Bun.file(path).json();
  // Call after loading the SDK, which resolves native resources from its launch CWD.
  process.chdir(settings.root);
  return {
    config: settings.config,
    dataDir: settings.dataDir,
    root: settings.root,
    async connect(
      execute: (command: DesktopCommand) => Promise<unknown>,
      disconnected: () => void
    ) {
      const { url }: { url: string } = JSON.parse(channel);
      const socket = new WebSocket(url);
      const peer = createChannelPeer(
        (data) => socket.send(data),
        (body) => execute(body as DesktopCommand)
      );
      const opened = Promise.withResolvers<void>();
      socket.addEventListener("open", () => opened.resolve());
      socket.addEventListener("error", () =>
        opened.reject(new Error("Desktop backend is unreachable."))
      );
      socket.addEventListener("message", (event) => peer.receive(String(event.data)));
      socket.addEventListener("close", () => {
        peer.close("Desktop backend disconnected.");
        disconnected();
      });
      await opened.promise;
      const request = (body: ShellRequest) => peer.request(body);
      const info = (await request({ type: "backend" })) as BackendInfo;
      const createWindowUrl = (destination?: string) =>
        mintWindowUrl(info.key, info.origin, destination);
      const backend: DesktopBackend = {
        origin: info.origin,
        bootstrapOrigin: "",
        url: createWindowUrl("/"),
        cookie: "",
        createWindowUrl,
        // The hot worker owns the backend lifetime; the shell never stops it.
        stop: () => Promise.resolve(),
      };
      return {
        backend,
        info,
        background: () => request({ type: "background" }) as Promise<boolean>,
        open: (event: OpenEvent) => request({ type: "open", event }) as Promise<boolean>,
        requestRestart: () => request({ type: "restart" }),
      };
    },
  };
}
