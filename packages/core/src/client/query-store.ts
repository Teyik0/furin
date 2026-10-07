import {
  type QueryIdentity,
  type QueryReadIdentity,
  type QuerySeed,
  queryTag,
  queryUrl,
} from "../shared/sync-query.ts";
import { createRequestId } from "./request-id.ts";

export const QUERY_REFERENCE = Symbol.for("furin.query.reference.v1");

export interface ReadResult {
  data: unknown;
  error: unknown;
  identity?: QueryReadIdentity;
  local?: boolean;
  response?: Response;
}

export interface ReadReference {
  client: QueryStore;
  load: (options: unknown) => Promise<ReadResult>;
  url: string;
}

export type QueryMethod = ((...args: never[]) => Promise<ReadResult>) & {
  readonly [QUERY_REFERENCE]: true;
};
export type QueryData<Method extends QueryMethod> = NonNullable<
  Awaited<ReturnType<Method>>["data"]
>;

export interface QuerySnapshot {
  data: unknown;
  error: unknown;
  isFetching: boolean;
}

interface QueryEntry {
  base: unknown;
  client?: QueryStore;
  identity?: QueryReadIdentity;
  listeners: Set<() => void>;
  load?: () => Promise<ReadResult>;
  local?: boolean;
  promise?: Promise<void>;
  snapshot: QuerySnapshot;
  stale: boolean;
  version: number;
}

export interface QueryProjection {
  onRemove?: () => void;
  pending: boolean;
  transforms: Map<QueryEntry, (data: unknown) => unknown>;
}

interface QueryEnvironment {
  onRead: () => void;
  origin: string;
  store: QueryStore;
}

const SERVER_ENVIRONMENT = Symbol.for("furin.query.environment.v1");
const environmentGlobal = globalThis as typeof globalThis & {
  [SERVER_ENVIRONMENT]?: () => QueryEnvironment | undefined;
};

/** @internal Installed by the server loader context; no server imports enter the browser bundle. */
export function setServerQueryEnvironment(read: () => QueryEnvironment | undefined): void {
  environmentGlobal[SERVER_ENVIRONMENT] = read;
}

export function currentQueryEnvironment(): QueryEnvironment | undefined {
  return environmentGlobal[SERVER_ENVIRONMENT]?.();
}

export function readReference(method: QueryMethod): ReadReference {
  return (method as unknown as { [QUERY_REFERENCE]: ReadReference })[QUERY_REFERENCE];
}

export function readUrl(reference: ReadReference, options: unknown): string {
  const url = new URL(reference.url);
  const query = (options as { query?: { [key: string]: unknown } } | undefined)?.query;
  const append = (key: string, value: unknown) => {
    if (value === undefined || value === null) {
      return;
    }
    let serialized = String(value);
    if (value instanceof Date) {
      serialized = value.toISOString();
    } else if (typeof value === "object") {
      serialized = JSON.stringify(value);
    }
    url.searchParams.append(key, serialized);
  };
  for (const [key, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        append(key, item);
      }
    } else {
      append(key, value);
    }
  }
  url.searchParams.sort();
  return url.href;
}

export class QueryStore {
  private readonly entries = new Map<string, QueryEntry>();
  private requests: { client: QueryStore; options: string; url: string; key: string }[] = [];
  private readonly optionObjects = new WeakMap<object, number>();
  private readonly requestScope = createRequestId();
  private nextRequest = 0;
  private nextOptionObject = 0;
  private readonly listeners = new Set<() => void>();
  private revisionValue = 0;
  private readonly projections = new Set<QueryProjection>();
  private session: string | undefined;
  private epoch = 0;
  private readonly origin: string | undefined;

  constructor(origin: string | undefined) {
    this.origin = origin;
  }

  private key(url: string): string {
    const absolute = new URL(url, this.origin);
    return (
      queryUrl(absolute.href, undefined) +
      (absolute.hash.startsWith("#furin-query:") ? absolute.hash : "")
    );
  }

  private optionValue(value: unknown): unknown {
    if (value instanceof Headers) {
      return [...value.entries()].sort(([left], [right]) => left.localeCompare(right));
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.optionValue(entry));
    }
    if (
      value !== null &&
      typeof value === "object" &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, this.optionValue(entry)])
      );
    }
    if ((value !== null && typeof value === "object") || typeof value === "function") {
      let id = this.optionObjects.get(value);
      if (id === undefined) {
        this.nextOptionObject += 1;
        id = this.nextOptionObject;
        this.optionObjects.set(value, id);
      }
      return { object: id };
    }
    return value;
  }

  private headerValue(value: unknown): unknown {
    if (value instanceof Headers) {
      return Object.fromEntries(value.entries());
    }
    if (typeof value === "function") {
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length === 2 && typeof value[0] === "string") {
        return [value[0].toLowerCase(), String(value[1])];
      }
      return value.map((source) => this.headerValue(source));
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([name, header]) => [name.toLowerCase(), String(header)])
      );
    }
    return value;
  }

  /** Options affect cache identity without exposing credentials in URLs or cache keys. */
  readKey(reference: ReadReference, options: unknown): string {
    const url = readUrl(reference, options);
    const requestOptions = Object.fromEntries(
      Object.entries(options ?? {})
        .filter(
          ([option, value]) => option !== "query" && option !== "select" && value !== undefined
        )
        .map(([option, value]) => [option, option === "headers" ? this.headerValue(value) : value])
    );
    const signature = JSON.stringify(this.optionValue(requestOptions));
    const existing = this.requests.find(
      (request) =>
        request.url === url && request.client === reference.client && request.options === signature
    );
    if (existing) {
      return existing.key;
    }
    const useUrl =
      signature === "{}" &&
      !this.requests.some((request) => request.url === url && request.key === url);
    if (!useUrl) {
      this.nextRequest += 1;
    }
    const key = useUrl ? url : `${url}#furin-query:${this.requestScope}:${this.nextRequest}`;
    this.requests.push({ client: reference.client, options: signature, url, key });
    return key;
  }

  private entry(url: string): QueryEntry {
    const key = this.key(url);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        base: undefined,
        listeners: new Set(),
        snapshot: { data: undefined, error: null, isFetching: false },
        stale: true,
        version: 0,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private publish(entry: QueryEntry): void {
    let data = entry.base;
    for (const projection of this.projections) {
      const transform = projection.transforms.get(entry);
      if (transform && data !== undefined) {
        data = transform(data);
      }
    }
    entry.snapshot = { ...entry.snapshot, data };
    for (const listener of entry.listeners) {
      listener();
    }
    this.revisionValue += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }

  revision = (): number => this.revisionValue;

  subscribeAll = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  observe(url: string, result: ReadResult, epoch: number, version?: number): void {
    const existing = this.entries.get(this.key(url));
    if (
      epoch !== this.epoch ||
      result.error !== null ||
      (existing &&
        (this.pending(existing) || (version !== undefined && existing.version !== version)))
    ) {
      return;
    }
    const header = result.response?.headers.get("x-furin-query");
    const identity =
      result.identity ?? (header ? (JSON.parse(header) as QueryReadIdentity) : undefined);
    if (identity && !new URL(url, this.origin).hash.startsWith("#furin-query:")) {
      this.setSession(identity.session);
    }
    const entry = this.entry(url);
    entry.base = result.data;
    entry.version += 1;
    entry.identity = identity;
    entry.local = result.local ?? result.response?.url === "";
    entry.stale = false;
    entry.snapshot = { data: result.data, error: null, isFetching: false };
    for (const projection of this.projections) {
      if (!projection.pending) {
        projection.transforms.delete(entry);
        if (projection.transforms.size === 0) {
          this.projections.delete(projection);
          projection.onRemove?.();
        }
      }
    }
    this.publish(entry);
    if (this.entries.size > 100) {
      const oldest = [...this.entries].find(
        ([, item]) =>
          item !== entry && item.listeners.size === 0 && !item.promise && !this.pending(item)
      );
      if (oldest) {
        this.entries.delete(oldest[0]);
        this.requests = this.requests.filter((request) => this.key(request.key) !== oldest[0]);
      }
    }
  }

  private setSession(session: string): void {
    if (this.session !== undefined && this.session !== session) {
      this.epoch += 1;
      for (const projection of this.projections) {
        projection.onRemove?.();
      }
      this.projections.clear();
      for (const entry of this.entries.values()) {
        entry.base = undefined;
        entry.identity = undefined;
        entry.stale = true;
        entry.version += 1;
        entry.snapshot = { data: undefined, error: null, isFetching: false };
        this.publish(entry);
      }
    }
    this.session = session;
  }

  generation(): number {
    return this.epoch;
  }

  version(url: string): number {
    return this.entry(url).version;
  }

  snapshot(url: string): QuerySnapshot {
    return this.entry(url).snapshot;
  }

  subscribe(url: string, listener: () => void): () => void {
    const entry = this.entry(url);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  bind(url: string, load: () => Promise<ReadResult>, client?: QueryStore): void {
    const entry = this.entry(url);
    if (client && entry.client && client !== entry.client) {
      entry.base = undefined;
      entry.identity = undefined;
      entry.stale = true;
      entry.version += 1;
      entry.snapshot = { data: undefined, error: null, isFetching: false };
      for (const projection of this.projections) {
        projection.transforms.delete(entry);
      }
    }
    entry.client = client ?? entry.client;
    entry.load = load;
  }

  private pending(entry: QueryEntry): boolean {
    return [...this.projections].some(
      (projection) => projection.pending && projection.transforms.has(entry)
    );
  }

  fetch(url: string): Promise<void> {
    const entry = this.entry(url);
    if (entry.promise) {
      return entry.promise;
    }
    if (!(entry.stale && entry.load) || this.pending(entry)) {
      return Promise.resolve();
    }
    const { version } = entry;
    const { epoch } = this;
    entry.snapshot = { ...entry.snapshot, isFetching: true };
    this.publish(entry);
    entry.promise = Promise.resolve()
      .then(() => entry.load?.())
      .then((result) => {
        if (!result || epoch !== this.epoch || version !== entry.version || this.pending(entry)) {
          return;
        }
        if (result.error === null) {
          this.observe(url, result, epoch);
        } else {
          entry.snapshot = { ...entry.snapshot, error: result.error };
        }
      })
      .catch((error: unknown) => {
        if (epoch === this.epoch && version === entry.version) {
          entry.snapshot = { ...entry.snapshot, error };
        }
      })
      .finally(() => {
        entry.promise = undefined;
        entry.snapshot = { ...entry.snapshot, isFetching: false };
        this.publish(entry);
        if (entry.stale && version !== entry.version && entry.listeners.size > 0) {
          this.fetch(url);
        }
      });
    return entry.promise;
  }

  invalidate(identities: readonly QueryIdentity[]): boolean {
    const tags = new Set(identities.map(queryTag));
    let affected = false;
    for (const [url, entry] of this.entries) {
      if (entry.identity && tags.has(queryTag(entry.identity))) {
        affected = true;
        this.invalidateEntry(url, entry);
      }
    }
    return affected;
  }

  private invalidateEntry(url: string, entry: QueryEntry): void {
    entry.stale = true;
    entry.version += 1;
    if (entry.listeners.size > 0) {
      this.fetch(url);
    }
  }

  invalidateAll(): void {
    for (const [url, entry] of this.entries) {
      this.invalidateEntry(url, entry);
    }
  }

  begin(): QueryProjection {
    return { pending: true, transforms: new Map() };
  }

  update(projection: QueryProjection, url: string, transform: (data: unknown) => unknown): void {
    const entry = this.entries.get(this.key(url));
    if (!entry || entry.base === undefined) {
      return;
    }
    const previous = projection.transforms.get(entry);
    projection.transforms.set(entry, previous ? (data) => transform(previous(data)) : transform);
    entry.version += 1;
    this.projections.add(projection);
    this.publish(entry);
  }

  finish(projection: QueryProjection, outcome: "success" | "error" | "ambiguous"): void {
    projection.pending = false;
    const entries = [...projection.transforms.keys()];
    if (outcome === "error") {
      this.projections.delete(projection);
      projection.onRemove?.();
    }
    for (const entry of entries) {
      this.publish(entry);
      if (outcome !== "error") {
        entry.stale = true;
      }
      const url = [...this.entries].find(([, candidate]) => candidate === entry)?.[0];
      if (url && entry.stale) {
        this.fetch(url);
      }
    }
  }

  dehydrate(): QuerySeed[] {
    return [...this.entries].flatMap(([url, entry]) => {
      if (!entry.identity || entry.base === undefined) {
        return [];
      }
      return [{ url, data: entry.base, identity: entry.identity, local: entry.local }];
    });
  }

  private seedUrl(seed: QuerySeed, localOrigin: string | undefined): string {
    const original = new URL(seed.url, this.origin);
    return seed.local && localOrigin
      ? new URL(original.pathname + original.search + original.hash, localOrigin).href
      : original.href;
  }

  captureHydration(): (seeds: readonly QuerySeed[], localOrigin: string | undefined) => void {
    const { epoch } = this;
    const versions = new Map([...this.entries].map(([key, entry]) => [key, entry.version]));
    return (seeds, localOrigin) => {
      if (epoch === this.epoch) {
        this.hydrate(
          seeds.filter((seed) => {
            const url = this.seedUrl(seed, localOrigin);
            return this.version(url) === (versions.get(this.key(url)) ?? 0);
          }),
          localOrigin
        );
      }
    };
  }

  hydrate(seeds: readonly QuerySeed[], localOrigin?: string): void {
    for (const seed of seeds) {
      const url = this.seedUrl(seed, localOrigin);
      this.observe(
        url,
        {
          data: seed.data,
          error: null,
          identity: seed.identity,
          local: seed.local ?? false,
        },
        this.epoch
      );
    }
  }
}
