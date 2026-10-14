import type { RedisClient } from "bun";
import type {
  BeginMutationInput,
  BeginMutationResult,
  ChangePage,
  CompleteMutationInput,
  CompleteMutationResult,
  MutationLease,
  ReadChangesInput,
  StoredResponse,
  SyncAdapter,
  SyncChange,
  SyncInvalidation,
  SyncNotifier,
  SyncSubscription,
} from "../adapter.ts";
import { journalChange, principalHash, registerPrincipalJournal } from "../principal-journal.ts";
import {
  ABORT_MUTATION_SCRIPT,
  BEGIN_MUTATION_SCRIPT,
  COMPLETE_MUTATION_SCRIPT,
  RENEW_MUTATION_SCRIPT,
} from "./scripts.ts";

const CHANGE_RETENTION = 1000;
const LEASE_MS = 30_000;
const MUTATION_TTL_MS = 24 * 60 * 60 * 1000;
const REDIS_STREAM_CURSOR_PATTERN = /^\d+-\d+$/;

export interface RedisSyncOptions {
  client: RedisClient;
  namespace: string;
}

interface SerializedResponse {
  body: string;
  headers: ReadonlyArray<readonly [string, string]>;
  status: number;
}

interface MutationDocument {
  fingerprint: string;
  id: string;
  leaseUntil?: number;
  response?: SerializedResponse | string;
  state: "in-progress" | "succeeded";
}

function assertNamespace(namespace: string): void {
  if (namespace.length === 0) {
    throw new Error("[furin-sync-redis] namespace must not be empty.");
  }
  if (!namespace.isWellFormed()) {
    throw new Error("[furin-sync-redis] namespace must contain valid Unicode.");
  }
}

function mutationDigest(input: Pick<MutationLease, "key" | "principal">): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${input.principal.length}:${input.principal}${input.key}`)
    .digest("hex");
}

function arrayResult(value: unknown, operation: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`[furin-sync-redis] Invalid ${operation} response.`);
  }
  return value;
}

function stringResult(value: unknown, operation: string): string {
  if (typeof value !== "string") {
    throw new Error(`[furin-sync-redis] Invalid ${operation} response.`);
  }
  return value;
}

function parseMutation(raw: string): MutationDocument {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    !("fingerprint" in value) ||
    typeof value.fingerprint !== "string" ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !("state" in value) ||
    (value.state !== "in-progress" && value.state !== "succeeded")
  ) {
    throw new Error("[furin-sync-redis] Invalid mutation document.");
  }
  return value as unknown as MutationDocument;
}

function deserializeResponse(document: MutationDocument): StoredResponse {
  const response =
    typeof document.response === "string"
      ? (JSON.parse(document.response) as SerializedResponse)
      : document.response;
  if (response === undefined) {
    throw new Error("[furin-sync-redis] Succeeded mutation has no replay response.");
  }
  return {
    body: Uint8Array.fromBase64(response.body),
    // Legacy Lua receipts encoded an empty header array as an empty object.
    headers: Array.isArray(response.headers) ? response.headers : [],
    status: response.status,
  };
}

function serializeResponse(response: StoredResponse): SerializedResponse {
  return {
    body: response.body.toBase64(),
    headers: response.headers,
    status: response.status,
  };
}

function compareStreamIds(left: string, right: string): number {
  if (!(REDIS_STREAM_CURSOR_PATTERN.test(left) && REDIS_STREAM_CURSOR_PATTERN.test(right))) {
    throw new Error("[furin-sync-redis] Invalid Redis Stream cursor.");
  }
  const leftParts = left.split("-");
  const rightParts = right.split("-");
  const leftTime = BigInt(leftParts[0] as string);
  const rightTime = BigInt(rightParts[0] as string);
  if (leftTime !== rightTime) {
    return leftTime < rightTime ? -1 : 1;
  }
  const leftSequence = BigInt(leftParts[1] as string);
  const rightSequence = BigInt(rightParts[1] as string);
  if (leftSequence === rightSequence) {
    return 0;
  }
  return leftSequence < rightSequence ? -1 : 1;
}

function streamEntries(value: unknown): [string, string, string | undefined][] {
  const entries = arrayResult(value, "stream read");
  return entries.map((entry) => {
    const tuple = arrayResult(entry, "stream entry");
    const cursor = stringResult(tuple[0], "stream cursor");
    const fields = arrayResult(tuple[1], "stream fields");
    if (fields[0] !== "data") {
      throw new Error("[furin-sync-redis] Invalid stream fields.");
    }
    const principalIndex = fields.indexOf("principal");
    return [
      cursor,
      stringResult(fields[1], "stream data"),
      principalIndex < 0 ? undefined : stringResult(fields[principalIndex + 1], "stream principal"),
    ];
  });
}

export class RedisSyncAdapter implements SyncAdapter {
  readonly scope = "distributed" as const;
  private readonly client: RedisClient;
  private readonly prefix: string;

  constructor(options: RedisSyncOptions) {
    assertNamespace(options.namespace);
    this.client = options.client;
    this.prefix = `furin:sync:{${encodeURIComponent(options.namespace)}}`;
    registerPrincipalJournal(this);
  }

  async beginMutation(input: BeginMutationInput): Promise<BeginMutationResult> {
    const id = crypto.randomUUID();
    const result = arrayResult(
      await this.client.send("EVAL", [
        BEGIN_MUTATION_SCRIPT,
        "1",
        this.mutationKey(input),
        input.fingerprint,
        id,
        String(LEASE_MS),
        String(MUTATION_TTL_MS),
      ]),
      "begin mutation"
    );
    const kind = stringResult(result[0], "begin mutation kind");
    if (kind === "execute") {
      return {
        kind,
        lease: { id, key: input.key, leaseMs: LEASE_MS, principal: input.principal },
      };
    }
    if (kind === "replay") {
      const document = parseMutation(stringResult(result[1], "replay mutation"));
      return { kind, response: deserializeResponse(document) };
    }
    if (kind === "conflict") {
      const reason = stringResult(result[1], "mutation conflict");
      if (reason === "in-progress" || reason === "payload-mismatch") {
        return { kind, reason };
      }
    }
    throw new Error("[furin-sync-redis] Invalid begin mutation result.");
  }

  async renewMutation(lease: MutationLease): Promise<"lost" | "renewed"> {
    const result = await this.client.send("EVAL", [
      RENEW_MUTATION_SCRIPT,
      "1",
      this.mutationKey(lease),
      lease.id,
      String(lease.leaseMs),
      String(MUTATION_TTL_MS),
    ]);
    if (result === "lost" || result === "renewed") {
      return result;
    }
    throw new Error("[furin-sync-redis] Invalid lease renewal result.");
  }

  async completeMutation(input: CompleteMutationInput): Promise<CompleteMutationResult> {
    const result = arrayResult(
      await this.client.send("EVAL", [
        COMPLETE_MUTATION_SCRIPT,
        "3",
        this.mutationKey(input.lease),
        this.streamKey,
        this.trimmedKey,
        input.lease.id,
        JSON.stringify(serializeResponse(input.response)),
        JSON.stringify(input.invalidations),
        String(MUTATION_TTL_MS),
        String(CHANGE_RETENTION),
        principalHash(input.lease.principal),
      ]),
      "complete mutation"
    );
    const kind = stringResult(result[0], "complete mutation kind");
    if (kind === "lost") {
      return { kind };
    }
    if (kind !== "committed") {
      throw new Error("[furin-sync-redis] Invalid complete mutation result.");
    }
    const cursor = stringResult(result[1], "complete mutation cursor");
    return cursor.length === 0 ? { cursor: undefined, kind } : { cursor, kind };
  }

  async abortMutation(lease: MutationLease): Promise<void> {
    await this.client.send("EVAL", [ABORT_MUTATION_SCRIPT, "1", this.mutationKey(lease), lease.id]);
  }

  async currentCursor(): Promise<string> {
    const entries = streamEntries(
      await this.client.send("XREVRANGE", [this.streamKey, "+", "-", "COUNT", "1"])
    );
    return entries[0]?.[0] ?? "0-0";
  }

  async readChanges(input: ReadChangesInput): Promise<ChangePage> {
    const currentCursor = await this.currentCursor();
    if (input.after === undefined) {
      return { changes: [], cursor: currentCursor, hasMore: false, reset: false };
    }
    try {
      compareStreamIds(input.after, "0-0");
    } catch {
      return { changes: [], cursor: currentCursor, hasMore: false, reset: true };
    }
    if (compareStreamIds(input.after, currentCursor) > 0) {
      return { changes: [], cursor: currentCursor, hasMore: false, reset: true };
    }
    const trimmed = await this.client.get(this.trimmedKey);
    if (trimmed !== null && compareStreamIds(input.after, trimmed) < 0) {
      return { changes: [], cursor: currentCursor, hasMore: false, reset: true };
    }
    const entries = streamEntries(
      await this.client.send("XRANGE", [
        this.streamKey,
        `(${input.after}`,
        "+",
        "COUNT",
        String(input.limit + 1),
      ])
    );
    const latestTrimmed = await this.client.get(this.trimmedKey);
    if (latestTrimmed !== null && compareStreamIds(input.after, latestTrimmed) < 0) {
      return {
        changes: [],
        cursor: await this.currentCursor(),
        hasMore: false,
        reset: true,
      };
    }
    const hasMore = entries.length > input.limit;
    const changes: SyncChange[] = entries.slice(0, input.limit).map(([cursor, raw, hash]) =>
      journalChange(
        {
          cursor,
          invalidations: JSON.parse(raw) as SyncInvalidation[],
        },
        hash
      )
    );
    return {
      changes,
      cursor: changes.at(-1)?.cursor ?? input.after,
      hasMore,
      reset: false,
    };
  }

  private mutationKey(input: Pick<MutationLease, "key" | "principal">): string {
    return `${this.prefix}:mutation:${mutationDigest(input)}`;
  }

  private get streamKey(): string {
    return `${this.prefix}:changes`;
  }

  private get trimmedKey(): string {
    return `${this.prefix}:trimmed`;
  }
}

export class RedisSyncNotifier implements SyncNotifier {
  private readonly channel: string;
  private readonly client: RedisClient;

  constructor(options: RedisSyncOptions) {
    assertNamespace(options.namespace);
    this.client = options.client;
    this.channel = `furin:sync:${options.namespace}:notify`;
  }

  async publish(cursor: string): Promise<void> {
    await this.client.publish(this.channel, cursor);
  }

  async subscribe(listener: (cursor: string) => void): Promise<SyncSubscription> {
    const subscriber = await this.client.duplicate();
    try {
      await subscriber.subscribe(this.channel, listener);
    } catch (error) {
      subscriber.close();
      throw error;
    }
    return {
      unsubscribe: async () => {
        await subscriber.unsubscribe(this.channel, listener);
        subscriber.close();
      },
    };
  }
}

export function redisSyncAdapter(options: RedisSyncOptions): RedisSyncAdapter {
  return new RedisSyncAdapter(options);
}

export function redisSyncNotifier(options: RedisSyncOptions): RedisSyncNotifier {
  return new RedisSyncNotifier(options);
}
