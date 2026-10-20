import type { ChangePage, ReadChangesInput, SyncAdapter, SyncChange } from "./adapter.ts";

const MIN_SECRET_LENGTH = 32;
const principalJournals = new WeakSet<SyncAdapter>();
const changePrincipals = new WeakMap<SyncChange, string>();
const principalSecrets = new WeakMap<SyncAdapter, string | undefined>();

/** Binds the runtime's `secret` to its adapter so every principal hash uses one key. */
export function configurePrincipalSecret(
  adapter: SyncAdapter,
  secret: string | undefined,
  development: boolean
): void {
  if (secret !== undefined && (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH)) {
    throw new Error(
      `[furin] sync.secret must be a string of at least ${MIN_SECRET_LENGTH} characters.`
    );
  }
  if (principalSecrets.has(adapter)) {
    if (principalSecrets.get(adapter) !== secret) {
      throw new Error("[furin] Sync runtimes sharing a SyncAdapter must use the same secret.");
    }
    return;
  }
  principalSecrets.set(adapter, secret);
  if (secret === undefined && !development) {
    console.warn(
      "[furin] sync.secret is not set: principal hashes sent to browsers and stored in the sync journal are unkeyed SHA-256 and can be reversed with a dictionary. Set sync.secret to a random value of at least 32 characters."
    );
  }
}

/** Transaction-scoped journals hash principals with the secret of the adapter that owns them. */
export function sharePrincipalSecret(journal: SyncAdapter, owner: SyncAdapter): void {
  principalSecrets.set(journal, principalSecrets.get(owner));
}

/** HMAC-SHA256 with the adapter's configured secret, or SHA-256 without one. */
export function principalHash(adapter: SyncAdapter, principal: string): string {
  const secret = principalSecrets.get(adapter);
  const hasher =
    secret === undefined ? new Bun.CryptoHasher("sha256") : new Bun.CryptoHasher("sha256", secret);
  return hasher.update(principal).digest("hex");
}

/** Built-in journals record provenance; arbitrary adapter output is never trusted. */
export function registerPrincipalJournal(adapter: SyncAdapter): void {
  principalJournals.add(adapter);
}

export function journalChange(change: SyncChange, hash: string | null | undefined): SyncChange {
  if (hash !== undefined && hash !== null) {
    changePrincipals.set(change, hash);
  }
  return change;
}

export async function readPrincipalChanges(
  adapter: SyncAdapter,
  input: ReadChangesInput,
  principal: string
): Promise<ChangePage> {
  if (principalJournals.has(adapter)) {
    const page = await adapter.readChanges(input);
    const hash = principalHash(adapter, principal);
    if (page.changes.every((change) => changePrincipals.get(change) === hash)) {
      return page;
    }
  }
  // Historical and other principals' rows require a refresh of authorized reads.
  const cursor = await adapter.currentCursor();
  return {
    changes: [],
    cursor,
    hasMore: false,
    reset: input.after !== undefined && input.after !== cursor,
  };
}
