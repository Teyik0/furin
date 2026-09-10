import type { BrowserEventEnvelope } from "../../shared/browser-events.ts";

export interface BrowserEventSubscription {
  unsubscribe: () => void;
}

export interface BrowserEventSource {
  subscribe: (
    listener: (event: Exclude<BrowserEventEnvelope, { channel: "sync" }>) => void
  ) => Promise<BrowserEventSubscription> | BrowserEventSubscription;
}
