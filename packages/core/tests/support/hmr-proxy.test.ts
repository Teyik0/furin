import { afterEach, expect, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";
import { getFreePort } from "./hmr.ts";
import { type HmrProxy, startHmrProxy } from "./hmr-proxy.ts";

let proxy: HmrProxy | undefined;
let upstream: Server | undefined;

async function waitForWebSocketCount(
  currentProxy: HmrProxy,
  pathname: string,
  expectedCount: number
): Promise<void> {
  const startedAt = Date.now();
  while (currentProxy.webSocketCount(pathname) !== expectedCount) {
    if (Date.now() - startedAt >= 1000) {
      throw new Error(`Timed out waiting for ${expectedCount} WebSocket connection(s)`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: poll the proxy's asynchronous socket registry
    await Bun.sleep(10);
  }
}

afterEach(() => {
  proxy?.close();
  proxy = undefined;
  upstream?.close();
  upstream = undefined;
});

test("forwards every client chunk received while the upstream connection opens", async () => {
  const upstreamPort = await getFreePort();
  const proxyPort = await getFreePort();
  const payload = Buffer.alloc(512 * 1024, 97);
  const received = new Promise<Buffer>((resolve, reject) => {
    upstream = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      );
      socket.once("end", () => resolve(Buffer.concat(chunks)));
      socket.once("error", reject);
    });
    upstream.once("error", reject);
    upstream.listen(upstreamPort, "127.0.0.1");
  });
  await new Promise<void>((resolve) => upstream?.once("listening", resolve));
  proxy = await startHmrProxy(proxyPort, upstreamPort);

  const client = connect({ host: "127.0.0.1", port: proxyPort });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  client.end(payload);

  expect(await received).toEqual(payload);
});

test("closes the client when the upstream connection fails", async () => {
  const upstreamPort = await getFreePort();
  const proxyPort = await getFreePort();
  proxy = await startHmrProxy(proxyPort, upstreamPort);

  const client = connect({ host: "127.0.0.1", port: proxyPort });
  client.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => client.once("close", resolve));
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  client.write("GET /_bun/hmr HTTP/1.1\r\nUpgrade: websocket\r\n\r\n");

  await Promise.race([
    closed,
    Bun.sleep(1000).then(() => {
      throw new Error("Timed out waiting for the proxy to close the client");
    }),
  ]);
});

test("drops only WebSockets matching the requested endpoint", async () => {
  const upstreamPort = await getFreePort();
  const proxyPort = await getFreePort();
  upstream = createServer((socket) => {
    socket.on("data", () => undefined);
  });
  upstream.listen(upstreamPort, "127.0.0.1");
  await new Promise<void>((resolve) => upstream?.once("listening", resolve));
  proxy = await startHmrProxy(proxyPort, upstreamPort);

  const hmrClient = connect({ host: "127.0.0.1", port: proxyPort });
  const eventClient = connect({ host: "127.0.0.1", port: proxyPort });
  hmrClient.on("error", () => undefined);
  eventClient.on("error", () => undefined);
  await Promise.all([
    new Promise<void>((resolve) => hmrClient.once("connect", resolve)),
    new Promise<void>((resolve) => eventClient.once("connect", resolve)),
  ]);
  hmrClient.write("GET /_bun/hmr HTTP/1.1\r\nUpgrade: websocket\r\n\r\n");
  eventClient.write("GET /_furin/events HTTP/1.1\r\nUpgrade: websocket\r\n\r\n");
  await waitForWebSocketCount(proxy, "/_bun/hmr", 1);
  await waitForWebSocketCount(proxy, "/_furin/events", 1);

  expect(proxy.dropWebSockets("/_bun/hmr")).toBe(1);
  await waitForWebSocketCount(proxy, "/_bun/hmr", 0);
  expect(proxy.webSocketCount("/_furin/events")).toBe(1);

  eventClient.destroy();
});
