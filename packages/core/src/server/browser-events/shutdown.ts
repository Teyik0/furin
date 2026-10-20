interface ClosingConnection {
  closed: Promise<void>;
  resolve: () => void;
}

const closeConnections = new WeakMap<Bun.Server<unknown>, Map<() => void, ClosingConnection>>();
const drainingServers = new WeakSet<Bun.Server<unknown>>();

export function registerBrowserEventConnection(
  server: Bun.Server<unknown>,
  close: () => void
): void {
  let connections = closeConnections.get(server);
  if (!connections) {
    connections = new Map();
    closeConnections.set(server, connections);
  }
  if (!connections.has(close)) {
    const { promise, resolve } = Promise.withResolvers<void>();
    connections.set(close, { closed: promise, resolve });
    if (drainingServers.has(server)) {
      close();
    }
  }
}

export function unregisterBrowserEventConnection(
  server: Bun.Server<unknown>,
  close: () => void
): void {
  const connections = closeConnections.get(server);
  connections?.get(close)?.resolve();
  connections?.delete(close);
}

export async function closeBrowserEventConnections(server: Bun.Server<unknown>): Promise<void> {
  drainingServers.add(server);
  const connections = closeConnections.get(server);
  if (!connections) {
    return;
  }
  while (connections.size > 0) {
    const pending = [...connections];
    for (const [close] of pending) {
      close();
    }
    // biome-ignore lint/performance/noAwaitInLoops: late upgrades must be drained after the previous connections close.
    await Promise.all(pending.map(([, connection]) => connection.closed));
  }
  closeConnections.delete(server);
}
