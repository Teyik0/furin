import type { ChangePage, ReadChangesInput, SyncAdapter, SyncChange } from "./adapter.ts";

const principalJournals = new WeakSet<SyncAdapter>();
const changePrincipals = new WeakMap<SyncChange, string>();

export function principalHash(principal: string): string {
  return new Bun.CryptoHasher("sha256").update(principal).digest("hex");
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
    const hash = principalHash(principal);
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
