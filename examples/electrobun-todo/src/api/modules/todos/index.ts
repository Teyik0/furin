import { furinSync } from "@teyik0/furin";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { ByIdPatch, Post } from "./model";
import { createTodo, deleteTodo, listTodos, updateTodo } from "./service";

export const todoPlugin = new Elysia()
  .use(furinSync(sync))
  .get("/todos", () => listTodos())
  // Self-invalidation refreshes GET /api/todos, read by the page loader.
  .post("/todos", { body: Post.Body }, ({ body, mutation }) =>
    mutation((tx) => createTodo(tx, body.title))
  )
  .patch(
    "/todos/:id",
    { body: ByIdPatch.Body },
    ({ params, body, mutation, problem, invalidate }) =>
      mutation((tx) => {
        const todo = updateTodo(tx, params.id, body);
        if (!todo) {
          return problem("Not Found", { detail: "Todo not found" });
        }
        invalidate("/api/todos");
        return todo;
      })
  )
  .delete("/todos/:id", ({ params, mutation, problem, invalidate }) =>
    mutation((tx) => {
      if (!deleteTodo(tx, params.id)) {
        return problem("Not Found", { detail: "Todo not found" });
      }
      invalidate("/api/todos");
      return { ok: true };
    })
  );
