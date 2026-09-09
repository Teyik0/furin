import { connect, createServer, type Server, type Socket } from "node:net";

const WEBSOCKET_UPGRADE_RE = /\r\nupgrade:\s*websocket\r\n/i;

interface ProxyConnection {
  client: Socket;
  upstream: Socket;
  webSocket: boolean;
}

export interface HmrProxy {
  close: () => void;
  dropWebSockets: () => number;
  webSocketCount: () => number;
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
        const connection: ProxyConnection = {
          client,
          upstream: connect({ host: "127.0.0.1", port: upstreamPort }),
          webSocket: WEBSOCKET_UPGRADE_RE.test(firstChunk.toString("latin1")),
        };
        connections.add(connection);
        connection.upstream.on("error", ignoreSocketError);
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
        dropWebSockets: () => {
          let dropped = 0;
          for (const connection of connections) {
            if (!connection.webSocket) {
              continue;
            }
            dropped += 1;
            connection.client.destroy();
            connection.upstream.destroy();
            connections.delete(connection);
          }
          return dropped;
        },
        webSocketCount: () => [...connections].filter((connection) => connection.webSocket).length,
      });
    });
  });
}
