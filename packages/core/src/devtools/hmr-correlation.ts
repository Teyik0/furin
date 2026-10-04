import type { DevtoolsBrowserEventInput, DevtoolsBrowserEventPayload } from "./protocol.ts";

type PhasePayload = Extract<DevtoolsBrowserEventPayload, { type: "hmr.client.phase" }>;
export type HmrPhaseSample = Omit<
  Extract<DevtoolsBrowserEventInput, { type: "hmr.client.phase" }>,
  "clientId"
> & { correlationRevision: number };

interface ClientUpdate {
  cycleId: string | null;
  lowerBound: number;
  samples: HmrPhaseSample[];
  startedAt: number;
}

const HISTORY_LIMIT = 50;
const SAMPLE_LIMIT = 100;
// Watcher callbacks can run just after Bun begins applying the browser update.
const WATCHER_SCHEDULING_MARGIN_MS = 10;

/** Keeps provisional measurements so late independent transports can reconcile them. */
export class HmrUpdateCorrelation {
  readonly #cycles = new Map<string, number>();
  readonly #updates: ClientUpdate[] = [];
  readonly #send: (sample: HmrPhaseSample) => void;
  #active: ClientUpdate | undefined;

  constructor(send: (sample: HmrPhaseSample) => void) {
    this.#send = send;
  }

  begin(startedAt: number): void {
    const previous = this.#updates.at(-1);
    const update: ClientUpdate = {
      cycleId: null,
      lowerBound: previous
        ? previous.startedAt + WATCHER_SCHEDULING_MARGIN_MS
        : Number.NEGATIVE_INFINITY,
      samples: [],
      startedAt,
    };
    this.#updates.push(update);
    this.#updates.splice(0, Math.max(0, this.#updates.length - HISTORY_LIMIT));
    this.#active = update;
    this.#reconcile(update);
  }

  record(payload: PhasePayload, clientTimestamp: number): void {
    const sample: HmrPhaseSample = {
      ...payload,
      clientTimestamp,
      correlationRevision: 0,
      cycleId: this.#active?.cycleId ?? null,
    };
    if (this.#active) {
      this.#active.samples.push(sample);
      this.#active.samples.splice(0, Math.max(0, this.#active.samples.length - SAMPLE_LIMIT));
    }
    this.#send(sample);
  }

  observe(cycleId: string, detectedAt: number): void {
    this.#cycles.set(cycleId, detectedAt);
    if (this.#cycles.size > HISTORY_LIMIT) {
      const oldest = this.#cycles.keys().next().value;
      if (oldest !== undefined) {
        this.#cycles.delete(oldest);
      }
    }
    for (const update of this.#updates) {
      this.#reconcile(update);
    }
  }

  currentCycleId(): string | null {
    return this.#active?.cycleId ?? null;
  }

  complete(): void {
    this.#active = undefined;
  }

  resetSession(since: number): void {
    this.#cycles.clear();
    const retained = this.#updates.filter((update) => update.startedAt >= since);
    this.#updates.splice(0, this.#updates.length, ...retained);
    if (this.#active && !retained.includes(this.#active)) {
      this.#active = undefined;
    }
    for (const update of retained) {
      update.lowerBound = Math.max(update.lowerBound, since);
      update.cycleId = null;
      for (const sample of update.samples) {
        sample.cycleId = null;
        sample.correlationRevision += 1;
        this.#send(sample);
      }
    }
  }

  #reconcile(update: ClientUpdate): void {
    if (update.cycleId !== null && !this.#cycles.has(update.cycleId)) {
      return;
    }
    const candidates = [...this.#cycles].filter(
      ([, detectedAt]) =>
        detectedAt > update.lowerBound &&
        detectedAt <= update.startedAt + WATCHER_SCHEDULING_MARGIN_MS
    );
    // Coalesced saves or overlapping observations have no unique public Bun ID.
    const cycleId = candidates.length === 1 ? (candidates[0]?.[0] ?? null) : null;
    if (cycleId === update.cycleId) {
      return;
    }
    update.cycleId = cycleId;
    for (const sample of update.samples) {
      sample.cycleId = cycleId;
      sample.correlationRevision += 1;
      this.#send(sample);
    }
  }
}
