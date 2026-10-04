import type { DevtoolsServerEvent } from "./protocol.ts";

/** Identity of replaceable browser samples, independent of server delivery order. */
export function devtoolsSampleKey(event: DevtoolsServerEvent): string | null {
  if (event.type === "browser.resources") {
    return JSON.stringify([event.sessionId, event.type, event.clientId]);
  }
  if (event.type === "hmr.client.phase") {
    return JSON.stringify([
      event.sessionId,
      event.type,
      event.clientId,
      event.clientTimestamp,
      event.phase,
      event.module,
    ]);
  }
  return null;
}

export function retainDevtoolsEvent(
  current: DevtoolsServerEvent[],
  next: DevtoolsServerEvent
): DevtoolsServerEvent[] {
  const key = devtoolsSampleKey(next);
  if (
    current.some(
      (event) =>
        event.sessionId === next.sessionId &&
        (event.id === next.id ||
          (key !== null && devtoolsSampleKey(event) === key && event.id > next.id))
    )
  ) {
    return current;
  }
  const retained = current.filter(
    (event) =>
      event.sessionId !== next.sessionId ||
      (event.id !== next.id && (key === null || devtoolsSampleKey(event) !== key))
  );
  return [...retained, next];
}
