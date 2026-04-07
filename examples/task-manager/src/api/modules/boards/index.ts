import { revalidatePath } from "@teyik0/furin";
import { Elysia, t } from "elysia";
import { createBoard, deleteBoard, getBoardData, getBoardStats, getBoards } from "./service";

export const boardPlugin = new Elysia()
  .get("/boards", () => getBoards())
  .post(
    "/boards",
    ({ body }) => {
      const board = createBoard(body.name);
      revalidatePath("/", "page");
      return board; // Return the created board as JSON; the client navigates via SPA
    },
    { body: t.Object({ name: t.String({ minLength: 1 }) }) }
  )
  .delete("/boards/:boardId", ({ params, status }) => {
    const ok = deleteBoard(params.boardId);
    if (!ok) {
      return status("Not Found", "Not found");
    }
    revalidatePath("/", "page");
    return { ok: true };
  })
  .get("/boards/:boardId", ({ params, status }) => {
    const data = getBoardData(params.boardId);
    if (!data) {
      return status("Not Found", "Not found");
    }
    return data;
  })
  .get("/boards/:boardId/stats", async ({ params, status }) => {
    // Artificial delay — makes the Suspense streaming boundary visible in the UI
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    const stats = getBoardStats(params.boardId);
    if (!stats) {
      return status("Not Found", "Not found");
    }
    return stats;
  });
