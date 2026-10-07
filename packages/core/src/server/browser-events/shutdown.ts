interface ClosingConnection {
  closed: Promise<void>;
  resolve: () => void;
}

const closeConnections = new WeakMap<Bun.Server<unknown>, Map<() => void, ClosingConnection>>();

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
  const connections = closeConnections.get(server);
  if (!connections) {
    return;
  }
  const closed = [...connections.values()].map((connection) => connection.closed);
  for (const close of connections.keys()) {
    close();
  }
  await Promise.all(closed);
  closeConnections.delete(server);
}
