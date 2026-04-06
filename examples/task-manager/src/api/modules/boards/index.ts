import { revalidatePath } from "@teyik0/furin";
import { Elysia, t } from "elysia";
import { createBoard, deleteBoard, getBoardData, getBoards } from "./service";

export const boardPlugin = new Elysia()
  .get("/boards", () => getBoards())
  .post(
    "/boards",
    ({ body, redirect }) => {
      createBoard(body.name);
      revalidatePath("/", "page");
      return redirect("/");
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
  });
