import { devtoolsSampleKey } from "../../devtools/event-history.ts";
import {
  DEVTOOLS_PROTOCOL_VERSION,
  type DevtoolsServerEvent,
  type DevtoolsServerEventInput,
} from "../../devtools/protocol.ts";
import { currentInstance, type FurinInstance } from "../instance.ts";

const EVENT_LIMIT = 1000;
// Match the collector's 50 retained updates with up to 100 samples each.
const PHASE_SAMPLE_LIMIT = 5000;

interface DevtoolsHub {
  events: DevtoolsServerEvent[];
  listeners: Set<(event: DevtoolsServerEvent) => void>;
  phaseSamples: Map<string, Extract<DevtoolsServerEvent, { type: "hmr.client.phase" }>>;
  sequence: number;
  sessionId: string;
}

const HUB_KEY = Symbol.for("furin.devtools.hub");

function instanceDevtoolsHub(instance?: FurinInstance): DevtoolsHub {
  const target = instance ?? currentInstance();
  const existing = target.state.get(HUB_KEY) as DevtoolsHub | undefined;
  if (existing) {
    return existing;
  }
  const hub: DevtoolsHub = {
    events: [],
    listeners: new Set(),
    phaseSamples: new Map(),
    sequence: 0,
    sessionId: crypto.randomUUID(),
  };
  target.state.set(HUB_KEY, hub);
  return hub;
}

export function devtoolsInstanceId(): string {
  const instance = currentInstance();
  return Bun.hash(`${instance.prefix}\0${instance.pagesDir}`).toString(16);
}

export function devtoolsEventsSnapshot(instance?: FurinInstance): {
  events: DevtoolsServerEvent[];
  lastEventId: number;
  sessionId: string;
} {
  const hub = instanceDevtoolsHub(instance);
  return { events: [...hub.events], lastEventId: hub.sequence, sessionId: hub.sessionId };
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
  const complete = {
    ...event,
    id: hub.sequence + 1,
    instanceId: devtoolsInstanceId(),
    sessionId: hub.sessionId,
    version: DEVTOOLS_PROTOCOL_VERSION,
  } as DevtoolsServerEvent;
  const sampleKey = devtoolsSampleKey(complete);
  if (sampleKey !== null && complete.type === "hmr.client.phase") {
    const previous = hub.phaseSamples.get(sampleKey);
    if (previous && (previous.correlationRevision ?? 0) >= (complete.correlationRevision ?? 0)) {
      return previous;
    }
    // Corrections change attribution, not when this browser sample was first observed.
    complete.timestamp = previous?.timestamp ?? complete.timestamp;
    hub.phaseSamples.delete(sampleKey);
    hub.phaseSamples.set(sampleKey, complete);
    if (hub.phaseSamples.size > PHASE_SAMPLE_LIMIT) {
      for (const oldestKey of hub.phaseSamples.keys()) {
        hub.phaseSamples.delete(oldestKey);
        break;
      }
    }
  }
  if (sampleKey !== null) {
    const previousIndex = hub.events.findIndex(
      (candidate) => devtoolsSampleKey(candidate) === sampleKey
    );
    if (previousIndex >= 0) {
      hub.events.splice(previousIndex, 1);
    }
  }
  hub.sequence += 1;
  hub.events.push(complete);
  if (hub.events.length > EVENT_LIMIT) {
    hub.events.shift();
  }
  for (const listener of hub.listeners) {
    listener(complete);
  }
  return complete;
}
