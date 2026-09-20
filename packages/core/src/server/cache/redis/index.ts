import type { RedisClient } from "bun";
import type {
  PageCacheAdapter,
  PageCacheEntry,
  PageCacheIdentity,
  PageCacheLease,
} from "../page-cache.ts";
import {
  ACQUIRE_PAGE_CACHE_LEASE_SCRIPT,
  COMMIT_PAGE_CACHE_ENTRY_SCRIPT,
  INVALIDATE_PAGE_CACHE_PATH_SCRIPT,
  INVALIDATE_PAGE_CACHE_TAGS_SCRIPT,
  READ_PAGE_CACHE_ENTRY_SCRIPT,
  RELEASE_PAGE_CACHE_LEASE_SCRIPT,
} from "./scripts.ts";

export interface RedisPageCacheOptions {
  client: RedisClient;
  namespace: string;
}

interface RedisLeaseDocument {
  expiresAt: number;
  fence: number;
  fields: string[];
  id: string;
  values: number[];
}

interface RedisEntryDocument {
  entry: PageCacheEntry;
  fields: string[];
  values: number[];
}

function assertNamespace(namespace: string): void {
  if (namespace.length === 0) {
    throw new Error("[furin-page-cache-redis] namespace must not be empty.");
  }
  if (!namespace.isWellFormed()) {
    throw new Error("[furin-page-cache-redis] namespace must contain valid Unicode.");
  }
}

function digest(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function identityDigest(identity: PageCacheIdentity): string {
  return digest(JSON.stringify([identity.scope, identity.buildId, identity.mode, identity.key]));
}

function layoutPaths(path: string): string[] {
  if (path === "/") {
    return ["/"];
  }
  const paths = ["/"];
  let current = "";
  for (const segment of path.split("/").filter(Boolean)) {
    current += `/${segment}`;
    paths.push(current);
  }
  return paths;
}

function selectorFields(identity: PageCacheIdentity): string[] {
  return [
    `page:${identity.path}`,
    ...layoutPaths(identity.path).map((path) => `layout:${path}`),
    ...identity.tags.map((tag) => `tag:${tag}`),
  ];
}

function stringResult(value: unknown, operation: string): string {
  if (typeof value !== "string") {
    throw new Error(`[furin-page-cache-redis] Invalid ${operation} response.`);
  }
  return value;
}

function stringArrayResult(value: unknown, operation: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`[furin-page-cache-redis] Invalid ${operation} response.`);
  }
  return value as string[];
}

function parseLease(raw: string): RedisLeaseDocument {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    !("expiresAt" in value) ||
    typeof value.expiresAt !== "number" ||
    !("fence" in value) ||
    typeof value.fence !== "number" ||
    !("fields" in value) ||
    !Array.isArray(value.fields) ||
    value.fields.some((field) => typeof field !== "string") ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("values" in value) ||
    !Array.isArray(value.values) ||
    value.values.some((revision) => typeof revision !== "number")
  ) {
    throw new Error("[furin-page-cache-redis] Invalid lease document.");
  }
  return value as RedisLeaseDocument;
}

function parseEntry(raw: string): PageCacheEntry {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    !("entry" in value) ||
    typeof value.entry !== "object" ||
    value.entry === null ||
    !("cachedAt" in value.entry) ||
    typeof value.entry.cachedAt !== "number" ||
    !("payload" in value.entry) ||
    typeof value.entry.payload !== "string" ||
    !("revalidate" in value.entry) ||
    (typeof value.entry.revalidate !== "number" && value.entry.revalidate !== null)
  ) {
    throw new Error("[furin-page-cache-redis] Invalid cache entry document.");
  }
  return value.entry as PageCacheEntry;
}

export class RedisPageCache implements PageCacheAdapter {
  private readonly client: RedisClient;
  private readonly prefix: string;

  constructor(options: RedisPageCacheOptions) {
    assertNamespace(options.namespace);
    this.client = options.client;
    this.prefix = `furin:page:{${encodeURIComponent(options.namespace)}}`;
  }

  async acquire({
    identity,
    leaseMs,
  }: {
    identity: PageCacheIdentity;
    leaseMs: number;
  }): Promise<PageCacheLease | null> {
    const id = crypto.randomUUID();
    const keys = [
      this.leaseKey(identity),
      this.fenceKey(identity),
      this.versionsKey(identity.scope),
    ];
    const raw = await this.client.send("EVAL", [
      ACQUIRE_PAGE_CACHE_LEASE_SCRIPT,
      String(keys.length),
      ...keys,
      id,
      String(leaseMs),
      JSON.stringify(selectorFields(identity)),
    ]);
    if (raw === null) {
      return null;
    }
    const lease = parseLease(stringResult(raw, "lease acquisition"));
    return {
      expiresAt: lease.expiresAt,
      fence: lease.fence,
      id: lease.id,
      revision: JSON.stringify(lease.values),
    };
  }

  async commit({
    entry,
    identity,
    lease,
  }: {
    entry: PageCacheEntry;
    identity: PageCacheIdentity;
    lease: PageCacheLease;
  }): Promise<"stored" | "superseded"> {
    const tagKeys = [...new Set(identity.tags)].map((tag) => this.tagPathsKey(identity.scope, tag));
    const document: RedisEntryDocument = {
      entry,
      fields: selectorFields(identity),
      values: JSON.parse(lease.revision) as number[],
    };
    const keys = [
      this.leaseKey(identity),
      this.entryKey(identity),
      this.versionsKey(identity.scope),
      this.pathsKey(identity.scope),
      ...tagKeys,
    ];
    const result = await this.client.send("EVAL", [
      COMMIT_PAGE_CACHE_ENTRY_SCRIPT,
      String(keys.length),
      ...keys,
      lease.id,
      String(lease.fence),
      JSON.stringify(document),
      identity.path,
    ]);
    if (result === "stored" || result === "superseded") {
      return result;
    }
    throw new Error("[furin-page-cache-redis] Invalid cache commit response.");
  }

  async invalidate(input: Parameters<PageCacheAdapter["invalidate"]>[0]) {
    if (input.kind === "path") {
      const result = stringArrayResult(
        await this.client.send("EVAL", [
          INVALIDATE_PAGE_CACHE_PATH_SCRIPT,
          "2",
          this.versionsKey(input.scope),
          this.pathsKey(input.scope),
          `${input.type}:${input.path}`,
          input.path,
          input.type,
        ]),
        "path invalidation"
      );
      return { invalidated: result.length > 0, paths: result };
    }

    const tags = [...new Set(input.tags)];
    const keys = [
      this.versionsKey(input.scope),
      ...tags.map((tag) => this.tagPathsKey(input.scope, tag)),
    ];
    const result = stringArrayResult(
      await this.client.send("EVAL", [
        INVALIDATE_PAGE_CACHE_TAGS_SCRIPT,
        String(keys.length),
        ...keys,
        JSON.stringify(tags),
      ]),
      "tag invalidation"
    );
    return { invalidated: result.length > 0, paths: result };
  }

  async read(identity: PageCacheIdentity): Promise<PageCacheEntry | null> {
    const raw = await this.client.send("EVAL", [
      READ_PAGE_CACHE_ENTRY_SCRIPT,
      "2",
      this.entryKey(identity),
      this.versionsKey(identity.scope),
    ]);
    if (raw === null) {
      return null;
    }
    return parseEntry(stringResult(raw, "cache read"));
  }

  async release({
    identity,
    lease,
  }: {
    identity: PageCacheIdentity;
    lease: PageCacheLease;
  }): Promise<void> {
    await this.client.send("EVAL", [
      RELEASE_PAGE_CACHE_LEASE_SCRIPT,
      "1",
      this.leaseKey(identity),
      lease.id,
      String(lease.fence),
    ]);
  }

  private entryKey(identity: PageCacheIdentity): string {
    return `${this.prefix}:entry:${identityDigest(identity)}`;
  }

  private fenceKey(identity: PageCacheIdentity): string {
    return `${this.prefix}:fence:${identityDigest(identity)}`;
  }

  private leaseKey(identity: PageCacheIdentity): string {
    return `${this.prefix}:lease:${identityDigest(identity)}`;
  }

  private pathsKey(scope: string): string {
    return `${this.prefix}:paths:${digest(scope)}`;
  }

  private tagPathsKey(scope: string, tag: string): string {
    return `${this.prefix}:tag-paths:${digest(scope)}:${digest(tag)}`;
  }

  private versionsKey(scope: string): string {
    return `${this.prefix}:versions:${digest(scope)}`;
  }
}

export function redisPageCache(options: RedisPageCacheOptions): PageCacheAdapter {
  return new RedisPageCache(options);
}
