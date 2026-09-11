import { connect, createServer, type Server, type Socket } from "node:net";

const WEBSOCKET_UPGRADE_RE = /\r\nupgrade:\s*websocket\r\n/i;
const REQUEST_TARGET_RE = /^GET\s+(\S+)\s+HTTP\//i;

interface ProxyConnection {
  client: Socket;
  pathname: string | undefined;
  upstream: Socket;
  webSocket: boolean;
}

export interface HmrProxy {
  close: () => void;
  dropWebSockets: (pathname: string) => number;
  webSocketCount: (pathname: string) => number;
}

function ignoreSocketError(): void {
  // Connection resets are expected when a test severs the HMR transport.
}

export function startHmrProxy(listenPort: number, upstreamPort: number): Promise<HmrProxy> {
  const connections = new Set<ProxyConnection>();
  let server: Server;

  return new Promise((resolve, reject) => {
    server = createServer((client) => {
      client.on("error", ignoreSocketError);
      client.once("data", (firstChunk) => {
        client.pause();
        const request = firstChunk.toString("latin1");
        const webSocket = WEBSOCKET_UPGRADE_RE.test(request);
        const requestTarget = webSocket ? REQUEST_TARGET_RE.exec(request)?.[1] : undefined;
        const connection: ProxyConnection = {
          client,
          pathname: requestTarget
            ? new URL(requestTarget, "http://proxy.invalid").pathname
            : undefined,
          upstream: connect({ host: "127.0.0.1", port: upstreamPort }),
          webSocket,
        };
        connections.add(connection);
        connection.upstream.once("error", () => client.destroy());
        const forget = () => connections.delete(connection);
        client.once("close", forget);
        connection.upstream.once("close", forget);
        connection.upstream.once("connect", () => {
          connection.upstream.write(firstChunk);
          client.pipe(connection.upstream);
          connection.upstream.pipe(client);
          client.resume();
        });
      });
    });
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        close: () => {
          for (const connection of connections) {
            connection.client.destroy();
            connection.upstream.destroy();
          }
          connections.clear();
          server.close();
        },
        dropWebSockets: (pathname) => {
          let dropped = 0;
          for (const connection of connections) {
            if (!(connection.webSocket && connection.pathname === pathname)) {
              continue;
            }
            dropped += 1;
            connection.client.destroy();
            connection.upstream.destroy();
            connections.delete(connection);
          }
          return dropped;
        },
        webSocketCount: (pathname) =>
          [...connections].filter(
            (connection) => connection.webSocket && connection.pathname === pathname
          ).length,
      });
    });
  });
}
