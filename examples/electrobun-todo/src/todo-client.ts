import { createClient } from "@teyik0/furin/client";
import type { TodoApi } from "./todo-backend";

export function createTodoClient(domain: string | TodoApi) {
  return createClient<TodoApi>(domain, { retry: 2 });
}
