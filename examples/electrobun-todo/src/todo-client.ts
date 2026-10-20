import { treaty } from "@elysia/eden";
import { furinSync } from "@teyik0/furin/client";
import type { TodoApi } from "./todo-backend";

export function createTodoClient(domain: string) {
  return treaty<TodoApi>(domain).use(furinSync);
}
