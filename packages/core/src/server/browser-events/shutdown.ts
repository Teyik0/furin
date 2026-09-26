const closeConnections = new WeakMap<Bun.Server<unknown>, Set<() => void>>();

export function registerBrowserEventConnection(
  server: Bun.Server<unknown>,
  close: () => void
): void {
  let connections = closeConnections.get(server);
  if (!connections) {
    connections = new Set();
    closeConnections.set(server, connections);
  }
  connections.add(close);
}

export function unregisterBrowserEventConnection(
  server: Bun.Server<unknown>,
  close: () => void
): void {
  closeConnections.get(server)?.delete(close);
}

export function closeBrowserEventConnections(server: Bun.Server<unknown>): void {
  const connections = closeConnections.get(server);
  if (!connections) {
    return;
  }
  closeConnections.delete(server);
  for (const close of connections) {
    close();
  }
  connections.clear();
}
