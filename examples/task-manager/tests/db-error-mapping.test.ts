import { afterEach, expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm/errors";
import { Elysia, t } from "elysia";
import { dbErrors } from "../src/api";
import { db } from "../src/db";
import { cards } from "../src/db/schema";

const SQLITE_CODE = /^SQLITE/;

// Fresh app reusing the real error-mapping plugin, with a route that throws
// whatever error a test sets. No module mocking: bun test runs files in one
// process, so mocking shared modules would leak across test files.
let forcedError: Error | undefined;

const app = new Elysia()
  .use(dbErrors)
  .post("/boom", { body: t.Object({ kind: t.String() }) }, ({ body }) => {
    if (body.kind === "create-card") {
      if (forcedError) {
        throw forcedError;
      }
      return {
        boardId: "b1",
        column: "todo",
        createdAt: "",
        description: "",
        id: "c1",
        position: 0,
        title: "T",
      };
    }
    throw new Error("unknown kind");
  });

const postBoom = () =>
  new Request("http://localhost/boom", {
    body: JSON.stringify({ kind: "create-card" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

afterEach(() => {
  forcedError = undefined;
});

test("DrizzleQueryError with a SQLITE_CONSTRAINT cause maps to a 409 problem", async () => {
  forcedError = new DrizzleQueryError(
    "insert into cards",
    [],
    Object.assign(new Error("UNIQUE constraint failed: cards.id"), {
      code: "SQLITE_CONSTRAINT_UNIQUE",
    })
  );

  const res = await app.handle(postBoom());
  expect(res.status).toBe(409);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  const body = (await res.json()) as { detail?: string; status: number; title?: string };
  expect(body.status).toBe(409);
  expect(body.detail).toContain("SQLITE_CONSTRAINT_UNIQUE");
});

test("DrizzleQueryError with SQLITE_BUSY cause maps to a 503 problem", async () => {
  forcedError = new DrizzleQueryError(
    "insert into cards",
    [],
    Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
  );

  const res = await app.handle(postBoom());
  expect(res.status).toBe(503);
});

test("DrizzleQueryError without a known cause code falls back to a 500 problem", async () => {
  forcedError = new DrizzleQueryError("select 1", [], new Error("mystery"));

  const res = await app.handle(postBoom());
  expect(res.status).toBe(500);
  expect(((await res.json()) as { detail: string }).detail).toBe("Database query failed");
});

test("a bare DrizzleError maps to a 500 problem", async () => {
  forcedError = new DrizzleError({ cause: new Error("raw driver failure"), message: "boom" });

  const res = await app.handle(postBoom());
  expect(res.status).toBe(500);
  expect(((await res.json()) as { detail: string }).detail).toBe("Database operation failed");
});

test("a raw driver error thrown from a handler maps through the code fallback", async () => {
  forcedError = Object.assign(new Error("FOREIGN KEY constraint failed"), {
    code: "SQLITE_CONSTRAINT_FOREIGNKEY",
  });

  const res = await app.handle(postBoom());
  expect(res.status).toBe(409);
  expect(((await res.json()) as { detail: string }).detail).toContain("FOREIGNKEY");
});

test("an unrelated error keeps the default error handling", async () => {
  forcedError = new Error("plain runtime failure");

  const res = await app.handle(postBoom());
  expect(res.status).toBe(500);
});

test("POST /cards on a missing board returns a 404 problem before touching the DB", async () => {
  // Integration path: the real card plugin pre-checks the board, so the FK
  // constraint can never fire for a missing board through the API.
  const { api } = await import("../src/api");
  const realBoardId = (await import("../src/api/modules/boards/service")).getBoards()[0]?.id;
  expect(realBoardId).toBeDefined();

  const res = await api.handle(
    new Request("http://localhost/api/boards/board-does-not-exist/cards", {
      body: JSON.stringify({ column: "todo", title: "Test card" }),
      // furinSync requires an Idempotency-Key on every mutation method (428 otherwise).
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      method: "POST",
    })
  );
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  expect(((await res.json()) as { status: number }).status).toBe(404);
});

test("bun:sqlite throws the raw driver error with its native code (sync path)", () => {
  let thrown: unknown;
  try {
    db.insert(cards)
      .values({
        boardId: "no-such-board",
        column: "todo",
        createdAt: new Date().toISOString(),
        id: "fk-violation-test",
        position: 0,
        title: "FK violation",
      })
      .run();
  } catch (error: unknown) {
    thrown = error;
  }

  // Sync drivers bypass DrizzleQueryError: the native SQLiteError surfaces
  // directly, carrying its own `code` (no `cause` indirection).
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as DrizzleQueryError).cause).toBeUndefined();
  const { code } = thrown as { code?: string };
  expect(code).toBeDefined();
  expect(String(code)).toMatch(SQLITE_CODE);
});

// Runtime check of the Eden treaty path through the error-mapping plugin.
test("treaty exposes the mapped error as an EdenFetchError with a numeric status", async () => {
  forcedError = new DrizzleQueryError(
    "insert into cards",
    [],
    Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT" })
  );

  const result = await treaty(app).boom.post({ kind: "create-card" });
  expect(result.error).not.toBeNull();
  expect(result.error?.status).toBe(409);

  // Type-level: status must be inferred as a number, not unknown. This line
  // fails `tsc --noEmit` if the registered error classes stop flowing through
  // Eden's route error resolution.
  const status: number | undefined = result.error?.status;
  expect(status).toBe(409);
});
