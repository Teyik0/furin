import { furinSync } from "@teyik0/furin";
import type { SyncInvalidationInput } from "@teyik0/furin/sync";
import { Elysia, t } from "elysia";
import { taskManagerSync } from "../../../sync";
import { createBoard, deleteBoard, getBoardData, getBoardStats, getBoards } from "./service";

const BOARD_MUTATION_INVALIDATIONS = [
  { id: "boards", scope: {} },
  { path: "/", type: "page" as const },
  { path: "/rsc", type: "page" as const },
  { path: "/board", type: "layout" as const },
] satisfies SyncInvalidationInput;

export const boardPlugin = new Elysia()
  .use(furinSync(taskManagerSync))
  .get("/boards", { sync: { id: "boards" } }, () => getBoards())
  .post(
    "/boards",
    {
      body: t.Object({ name: t.String({ minLength: 1 }) }),
      sync: { invalidate: BOARD_MUTATION_INVALIDATIONS },
    },
    ({ body, mutation }) => mutation((tx) => createBoard(tx, body.name))
  )
  .delete(
    "/boards/:boardId",
    { sync: { invalidate: BOARD_MUTATION_INVALIDATIONS } },
    ({ params, problem, mutation }) =>
      mutation((tx) => {
        const ok = deleteBoard(tx, params.boardId);
        if (!ok) {
          return problem("Not Found", { detail: "Board not found" });
        }
        return { ok: true };
      })
  )
  .get(
    "/boards/:boardId",
    { sync: { id: "board", scope: ({ params }) => ({ boardId: params.boardId }) } },
    ({ params, problem }) => {
      const data = getBoardData(params.boardId);
      if (!data) {
        return problem("Not Found", { detail: "Board not found" });
      }
      return data;
    }
  )
  .get(
    "/boards/:boardId/stats",
    { sync: { id: "board", scope: ({ params }) => ({ boardId: params.boardId }) } },
    async ({ params, problem }) => {
      // Artificial delay — makes the Suspense streaming boundary visible in the UI
      await new Promise<void>((resolve) => setTimeout(resolve, 800));
      const stats = getBoardStats(params.boardId);
      if (!stats) {
        return problem("Not Found", { detail: "Board not found" });
      }
      return stats;
    }
  );
