import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createTodoBackend } from "./todo-backend";

const backendKey = Symbol.for("furin.relay.backend");
const backendGlobal = globalThis as typeof globalThis & {
  [backendKey]?: ReturnType<typeof createTodoBackend>;
};

export function getTodoDatabaseFilename() {
  const filename =
    process.env.FURIN_TODO_DATABASE ??
    resolve(process.env.FURIN_APP_DATA_DIR ?? ".furin", "todos.sqlite");
  mkdirSync(dirname(filename), { recursive: true });
  return filename;
}

// The web server shares one repository across its versioned route modules.
export function getTodoBackend() {
  if (!backendGlobal[backendKey]) {
    backendGlobal[backendKey] = createTodoBackend(getTodoDatabaseFilename());
  }
  return backendGlobal[backendKey];
}

export function closeTodoBackend() {
  backendGlobal[backendKey]?.close();
  backendGlobal[backendKey] = undefined;
}
