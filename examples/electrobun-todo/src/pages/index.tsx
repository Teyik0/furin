import { defineRoute } from "@teyik0/furin";
import { getTodoBackend } from "../backend-instance";
import { TodoScreen } from "../ui/todo-screen";
import { route as rootRoute } from "./root";

export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(() => ({ todos: getTodoBackend().list() }))
  .head(() => ({ meta: [{ title: "Relay — Furin" }] }))
  .page(({ todos }) => <TodoScreen todos={todos} />);
