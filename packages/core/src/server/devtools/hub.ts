import {
  DEVTOOLS_PROTOCOL_VERSION,
  type DevtoolsServerEvent,
  type DevtoolsServerEventInput,
} from "../../devtools/protocol.ts";
import { currentInstance, type FurinInstance, instanceSlot } from "../instance.ts";

const EVENT_LIMIT = 1000;

interface DevtoolsHub {
  events: DevtoolsServerEvent[];
  listeners: Set<(event: DevtoolsServerEvent) => void>;
  sequence: number;
}

const instanceDevtoolsHub = instanceSlot(
  (): DevtoolsHub => ({ events: [], listeners: new Set(), sequence: 0 })
);

export function devtoolsInstanceId(): string {
  const instance = currentInstance();
  return Bun.hash(`${instance.prefix}\0${instance.pagesDir}`).toString(16);
}

export function devtoolsEventsSnapshot(instance?: FurinInstance): {
  events: DevtoolsServerEvent[];
  lastEventId: number;
} {
  const hub = instanceDevtoolsHub(instance);
  return { events: [...hub.events], lastEventId: hub.sequence };
}

export function subscribeDevtoolsEventsAfter(
  cursor: number,
  listener: (event: DevtoolsServerEvent) => void,
  instance?: FurinInstance
): { replay: DevtoolsServerEvent[]; unsubscribe: () => void } {
  const hub = instanceDevtoolsHub(instance);
  hub.listeners.add(listener);
  return {
    replay: hub.events.filter((event) => event.id > cursor),
    unsubscribe: () => {
      hub.listeners.delete(listener);
    },
  };
}

export function appendDevtoolsEvent(event: DevtoolsServerEventInput): DevtoolsServerEvent {
  const hub = instanceDevtoolsHub();
  hub.sequence += 1;
  const complete = {
    ...event,
    id: hub.sequence,
    instanceId: devtoolsInstanceId(),
    version: DEVTOOLS_PROTOCOL_VERSION,
  } as DevtoolsServerEvent;
  if (complete.type === "browser.resources") {
    const previousIndex = hub.events.findIndex(
      (candidate) =>
        candidate.type === "browser.resources" && candidate.clientId === complete.clientId
    );
    if (previousIndex >= 0) {
      hub.events.splice(previousIndex, 1);
    }
  }
  hub.events.push(complete);
  if (hub.events.length > EVENT_LIMIT) {
    hub.events.shift();
  }
  for (const listener of hub.listeners) {
    listener(complete);
  }
  return complete;
}
