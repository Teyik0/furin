import { expect, test } from "bun:test";
import type { SyncAdapter } from "../../src/server/sync/adapter";
import { readPrincipalChanges } from "../../src/server/sync/principal-journal.ts";

const response = {
  body: new TextEncoder().encode("created"),
  headers: [["content-type", "text/plain"]],
  status: 201,
} as const;

async function appendPageChange(adapter: SyncAdapter, index: number): Promise<void> {
  const mutation = await adapter.beginMutation({
    fingerprint: `page-body-${index}`,
    key: `page-mutation-${index}`,
    principal: "conformance-user",
  });
  if (mutation.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }
  await adapter.completeMutation({
    invalidations: [{ kind: "path", path: `/page-${index}`, type: "page" }],
    lease: mutation.lease,
    response,
  });
}

export function testSyncAdapterConformance(getAdapter: () => SyncAdapter): void {
  test("conforms to mutation replay and change catch-up", async () => {
    const adapter = getAdapter();
    const mutation = await adapter.beginMutation({
      fingerprint: "conformance-body",
      key: "conformance-mutation",
      principal: "conformance-user",
    });
    expect(mutation.kind).toBe("execute");
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }
    const completed = await adapter.completeMutation({
      invalidations: [{ kind: "path", path: "/conformance", type: "page" }],
      lease: mutation.lease,
      response,
    });
    expect(completed.kind).toBe("committed");
    expect(
      await adapter.beginMutation({
        fingerprint: "conformance-body",
        key: "conformance-mutation",
        principal: "conformance-user",
      })
    ).toEqual({ kind: "replay", response });

    const changes = await adapter.readChanges({
      after: completed.kind === "committed" ? initialCursor(completed.cursor) : undefined,
      limit: 10,
    });
    expect(changes.reset).toBe(false);
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]?.invalidations).toEqual([
      { kind: "path", path: "/conformance", type: "page" },
    ]);
  });

  test("conforms to conflict and abort semantics", async () => {
    const adapter = getAdapter();
    const mutation = await adapter.beginMutation({
      fingerprint: "conformance-body",
      key: "conformance-mutation",
      principal: "conformance-user",
    });
    expect(mutation.kind).toBe("execute");
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }
    expect(
      await adapter.beginMutation({
        fingerprint: "other-body",
        key: "conformance-mutation",
        principal: "conformance-user",
      })
    ).toEqual({ kind: "conflict", reason: "payload-mismatch" });
    await adapter.abortMutation(mutation.lease);
    expect(
      await adapter.beginMutation({
        fingerprint: "conformance-body",
        key: "conformance-mutation",
        principal: "conformance-user",
      })
    ).toMatchObject({ kind: "execute" });
  });

  test("conforms to ordered pagination", async () => {
    const adapter = getAdapter();
    const initial = await adapter.currentCursor();
    await appendPageChange(adapter, 0);
    await appendPageChange(adapter, 1);
    await appendPageChange(adapter, 2);

    const first = await adapter.readChanges({ after: initial, limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.changes.map((change) => change.invalidations[0])).toEqual([
      { kind: "path", path: "/page-0", type: "page" },
      { kind: "path", path: "/page-1", type: "page" },
    ]);
    const second = await adapter.readChanges({ after: first.cursor, limit: 2 });
    expect(second.hasMore).toBe(false);
    expect(second.changes.map((change) => change.invalidations[0])).toEqual([
      { kind: "path", path: "/page-2", type: "page" },
    ]);
  });

  test("conforms to journal-only invalidations", async () => {
    const adapter = getAdapter();
    const initial = await adapter.currentCursor();
    const invalidations = [{ kind: "tags", tags: ["journal-only"] }] as const;

    const cursor = await adapter.appendInvalidations(invalidations);

    expect(await adapter.currentCursor()).toBe(cursor);
    const page = await adapter.readChanges({ after: initial, limit: 10 });
    expect(page.changes).toEqual([{ cursor, invalidations }]);
  });

  test("conforms to reset semantics for a future cursor", async () => {
    const adapter = getAdapter();
    const current = await adapter.currentCursor();
    expect(await adapter.readChanges({ after: futureCursor(current), limit: 10 })).toMatchObject({
      changes: [],
      cursor: current,
      reset: true,
    });
  });

  test("preserves explicit background provenance without exposing another principal's tags", async () => {
    const adapter = getAdapter();
    const after = await adapter.currentCursor();
    const invalidations = [{ kind: "tags", tags: ["private-background-change"] }] as const;
    const cursor = await adapter.appendInvalidations(invalidations, "alice");
    expect(await readPrincipalChanges(adapter, { after, limit: 10 }, "alice")).toEqual({
      changes: [{ cursor, invalidations }],
      cursor,
      hasMore: false,
      reset: false,
    });
    expect(await readPrincipalChanges(adapter, { after, limit: 10 }, "bob")).toEqual({
      changes: [],
      cursor,
      hasMore: false,
      reset: true,
    });
  });
}

function initialCursor(cursor: string | undefined): string {
  if (cursor === undefined) {
    throw new Error("Expected a change cursor");
  }
  return cursor.includes("-") ? "0-0" : "0";
}

function futureCursor(cursor: string): string {
  if (!cursor.includes("-")) {
    return String(BigInt(cursor) + 1n);
  }
  const [time] = cursor.split("-");
  return `${BigInt(time as string) + 1n}-0`;
}
