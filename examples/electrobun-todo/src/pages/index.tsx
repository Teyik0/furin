import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { TodoApp } from "../components/todo-app";
import { api } from "../lib/api";

export const route = defineRoute("/")
  .config({
    mode: "ssr",
    query: t.Object({ filter: t.Optional(t.UnionEnum(["active", "completed"])) }),
  })
  .loader(async () => {
    const { data, error } = await api.todos.get.live();
    if (error) {
      throw error;
    }
    return { todos: data };
  })
  .head(() => ({ meta: [{ title: "Relay — Furin" }] }))
  .page(({ todos, query }) => <TodoApp filter={query.filter} todos={todos} />);
