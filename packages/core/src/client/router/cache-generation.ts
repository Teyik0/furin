import type { RouterState } from "./types.ts";

type Affects = (href: string, snapshot: RouterState) => boolean;

/** Invalidations kept to prove freshness; older snapshots are treated as stale. */
const MAX_TRACKED_INVALIDATIONS = 64;

/**
 * Monotonic generation bumped by every prefetch-cache invalidation. A snapshot
 * stamped with the generation at which its fetch started is fresh only when no
 * later invalidation affects it, so data requested before a write can never
 * look fresh after that write, whether it was cached or still in flight.
 */
export class CacheGeneration {
  #current = 0;
  readonly #log: Array<{ affects: Affects; generation: number }> = [];

  get current(): number {
    return this.#current;
  }

  bump(affects: Affects): void {
    this.#current += 1;
    this.#log.push({ affects, generation: this.#current });
    if (this.#log.length > MAX_TRACKED_INVALIDATIONS) {
      this.#log.shift();
    }
  }

  isFresh(href: string, snapshot: RouterState, since: number): boolean {
    const [oldest] = this.#log;
    if (oldest && since < oldest.generation - 1) {
      return false;
    }
    return !this.#log.some((entry) => entry.generation > since && entry.affects(href, snapshot));
  }
}
