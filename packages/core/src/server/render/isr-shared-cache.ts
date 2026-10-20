import { getISRCache } from "../cache/isr.ts";
import type { ISRCacheEntry } from "../cache/isr-ssg.ts";
import type {
  PageCacheAdapter,
  PageCacheEntry,
  PageCacheIdentity,
  PageCacheLease,
} from "../cache/page-cache.ts";
import { waitForPageCacheEntry } from "../cache/page-cache.ts";
import { getLogger } from "../context-logger.ts";

export interface SharedPageCacheContext {
  adapter: PageCacheAdapter;
  identity: PageCacheIdentity;
}

/** Shared page cache payload: the document and its navigation data, rendered together. */
export function serializeISRPayload(entry: ISRCacheEntry): string {
  return JSON.stringify({ html: entry.html, ndjson: entry.ndjson });
}

function toISRCacheEntry(entry: PageCacheEntry, revalidate: number): ISRCacheEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(entry.payload);
  } catch {
    return;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("html" in value) ||
    typeof value.html !== "string" ||
    !("ndjson" in value) ||
    typeof value.ndjson !== "string"
  ) {
    return;
  }
  return {
    generatedAt: entry.cachedAt,
    html: value.html,
    ndjson: value.ndjson,
    revalidate: entry.revalidate ?? revalidate,
  };
}

interface ISRCacheLookup {
  cached: ISRCacheEntry | undefined;
  sharedAvailable: boolean;
}

export async function lookupISRCache(
  pageCache: PageCacheAdapter | undefined,
  identity: PageCacheIdentity,
  cacheKey: string,
  externalPrerender: boolean,
  revalidate: number
): Promise<ISRCacheLookup> {
  if (pageCache === undefined) {
    return {
      cached: externalPrerender ? undefined : getISRCache(cacheKey),
      sharedAvailable: false,
    };
  }
  try {
    const entry = await pageCache.read(identity);
    return {
      cached: entry === null ? undefined : toISRCacheEntry(entry, revalidate),
      sharedAvailable: true,
    };
  } catch {
    getLogger().warn("ISR shared page cache read failed; rendering fresh with no-store");
    return { cached: undefined, sharedAvailable: false };
  }
}

interface ISRLeaseResult {
  lease: PageCacheLease | null;
  sharedAvailable: boolean;
}

const SHARED_ISR_LEASE_MS = 30_000;
const SHARED_ISR_WAIT_SLICE_MS = 2000;

export async function acquireISRLease(
  pageCache: PageCacheAdapter,
  identity: PageCacheIdentity
): Promise<ISRLeaseResult> {
  try {
    return {
      lease: await pageCache.acquire({ identity, leaseMs: SHARED_ISR_LEASE_MS }),
      sharedAvailable: true,
    };
  } catch {
    getLogger().warn("ISR shared page cache lease failed; rendering fresh with no-store");
    return { lease: null, sharedAvailable: false };
  }
}

interface ISRCoordinationResult extends ISRCacheLookup {
  lease: PageCacheLease | null;
}

export function coordinateConcurrentISR(
  pageCache: PageCacheAdapter,
  identity: PageCacheIdentity,
  revalidate: number
): Promise<ISRCoordinationResult> {
  return coordinateConcurrentISRUntil(
    pageCache,
    identity,
    revalidate,
    Date.now() + SHARED_ISR_LEASE_MS
  );
}

async function coordinateConcurrentISRUntil(
  pageCache: PageCacheAdapter,
  identity: PageCacheIdentity,
  revalidate: number,
  deadline: number
): Promise<ISRCoordinationResult> {
  if (Date.now() >= deadline) {
    return { cached: undefined, lease: null, sharedAvailable: true };
  }
  try {
    const entry = await waitForPageCacheEntry(pageCache, identity, SHARED_ISR_WAIT_SLICE_MS);
    const cached = entry === null ? undefined : toISRCacheEntry(entry, revalidate);
    if (cached !== undefined) {
      return { cached, lease: null, sharedAvailable: true };
    }
  } catch {
    getLogger().warn("ISR shared page cache wait failed; rendering fresh with no-store");
    return { cached: undefined, lease: null, sharedAvailable: false };
  }
  const leaseResult = await acquireISRLease(pageCache, identity);
  if (!leaseResult.sharedAvailable || leaseResult.lease !== null) {
    return { cached: undefined, ...leaseResult };
  }
  return coordinateConcurrentISRUntil(pageCache, identity, revalidate, deadline);
}
