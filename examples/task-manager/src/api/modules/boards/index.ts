import { furinSync } from "@teyik0/furin";
import { Elysia, t } from "elysia";
import { taskManagerSync } from "../../../sync";
import { createBoard, deleteBoard, getBoardData, getBoardStats, getBoards } from "./service";

export const boardPlugin = new Elysia()
  .use(furinSync(taskManagerSync))
  .get("/boards", () => getBoards())
  // Self-invalidation refreshes GET /api/boards, read by the index page and the board sidebar.
  .post("/boards", { body: t.Object({ name: t.String({ minLength: 1 }) }) }, ({ body, mutation }) =>
    mutation((tx) => createBoard(tx, body.name))
  )
  .delete("/boards/:boardId", ({ params, problem, mutation, invalidate }) =>
    mutation((tx) => {
      const ok = deleteBoard(tx, params.boardId);
      if (!ok) {
        return problem("Not Found", { detail: "Board not found" });
      }
      invalidate("/api/boards");
      return { ok: true };
    })
  )
  .get("/boards/:boardId", ({ params, problem }) => {
    const data = getBoardData(params.boardId);
    if (!data) {
      return problem("Not Found", { detail: "Board not found" });
    }
    return data;
  })
  .get("/boards/:boardId/stats", async ({ params, problem }) => {
    // Artificial delay — makes the Suspense streaming boundary visible in the UI
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    const stats = getBoardStats(params.boardId);
    if (!stats) {
      return problem("Not Found", { detail: "Board not found" });
    }
    return stats;
  });
