import type { DrainContext, WideEvent } from "evlog";

export interface EvlogCapture {
  drain: (context: DrainContext) => void;
  events: WideEvent[];
  /** Resolves with the next drained wide event. */
  next: () => Promise<WideEvent>;
}

/** A real evlog drain that records wide events, for `furin({ logger: { drain } })`. */
export function captureEvlogEvents(): EvlogCapture {
  const events: WideEvent[] = [];
  const waiters: ((event: WideEvent) => void)[] = [];
  return {
    drain: ({ event }) => {
      events.push(event);
      waiters.shift()?.(event);
    },
    events,
    next: () => {
      const { promise, resolve } = Promise.withResolvers<WideEvent>();
      waiters.push(resolve);
      return promise;
    },
  };
}
