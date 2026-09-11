import type { BrowserEventChannel, BrowserEventFor } from "../shared/browser-events.ts";

const BROWSER_EVENT_RUNTIME_KEY = Symbol.for("furin.browser-events.runtime");

interface BrowserEventRuntime {
  subscribe: <TChannel extends BrowserEventChannel>(
    channel: TChannel,
    listener: (event: BrowserEventFor<TChannel>) => void
  ) => () => void;
}

interface BrowserEventGlobal {
  [BROWSER_EVENT_RUNTIME_KEY]?: BrowserEventRuntime;
}

export function subscribeBrowserEvent<TChannel extends BrowserEventChannel>(
  channel: TChannel,
  listener: (event: BrowserEventFor<TChannel>) => void
): (() => void) | undefined {
  const runtime = (globalThis as BrowserEventGlobal)[BROWSER_EVENT_RUNTIME_KEY];
  return runtime?.subscribe(channel, listener);
}
