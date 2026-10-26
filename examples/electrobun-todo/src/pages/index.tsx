import { defineRoute } from "@teyik0/furin";
import { TodoApp } from "../components/todo-app";
import { api } from "../lib/api";

export const route = defineRoute("/")
  .config({ mode: "ssr" })
  .loader(async () => {
    // A live read: every mutation invalidating GET /api/todos refreshes this page.
    const { data, error } = await api.todos.get.live();
    if (error) {
      throw error;
    }
    return { todos: data };
  })
  .head(() => ({ meta: [{ title: "Relay — Furin" }] }))
  .page(({ todos }) => <TodoApp todos={todos} />);
