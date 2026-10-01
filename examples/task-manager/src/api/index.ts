import { furinSync } from "@teyik0/furin";
import { DrizzleError, DrizzleQueryError } from "drizzle-orm/errors";
import { Elysia, problem } from "elysia";
import { taskManagerSync } from "../sync";
import { boardPlugin } from "./modules/boards";
import { cardPlugin } from "./modules/cards";

const sqliteCode = (error: unknown): string => {
  const source = error as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  const code = source?.cause?.code ?? source?.code;
  return typeof code === "string" ? code : "";
};

function mapSqliteProblem(code: string) {
  if (code.startsWith("SQLITE_CONSTRAINT")) {
    return problem(409, { detail: `Database constraint violated (${code})` });
  }
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return problem(503, { detail: "Database busy, retry" });
  }
  return problem(500, { detail: "Database query failed" });
}

export const dbErrors = new Elysia({ name: "db-errors" })
  .error("global", DrizzleQueryError, ({ error }) => mapSqliteProblem(sqliteCode(error)))
  .error("global", DrizzleError, () => problem(500, { detail: "Database operation failed" }))
  .error("global", ({ error }) => {
    const code = sqliteCode(error);
    if (!code.startsWith("SQLITE")) {
      return;
    }
    return mapSqliteProblem(code);
  });

export const api = new Elysia()
  .use(furinSync(taskManagerSync))
  .use(new Elysia({ prefix: "/api" }).use(dbErrors).use(boardPlugin).use(cardPlugin));
export type Api = typeof api;
