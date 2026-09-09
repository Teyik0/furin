import { afterEach, expect, test } from "bun:test";
import { connect, createServer, type Server } from "node:net";
import { getFreePort } from "./hmr.ts";
import { type HmrProxy, startHmrProxy } from "./hmr-proxy.ts";

let proxy: HmrProxy | undefined;
let upstream: Server | undefined;

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
