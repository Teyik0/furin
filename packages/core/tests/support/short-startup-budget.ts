// Preloaded into `furin dev` subprocesses: the web development worker's
// 30-second startup budget elapses after 3 seconds instead.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
  realSetTimeout(handler, delay === 30_000 ? 3000 : delay, ...args)) as typeof setTimeout;
