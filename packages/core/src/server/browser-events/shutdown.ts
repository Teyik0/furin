const closeConnections = new Set<() => void>();

export function registerBrowserEventConnection(close: () => void): void {
  closeConnections.add(close);
}

export function unregisterBrowserEventConnection(close: () => void): void {
  closeConnections.delete(close);
}

export function closeBrowserEventConnections(): void {
  for (const close of closeConnections) {
    close();
  }
}
