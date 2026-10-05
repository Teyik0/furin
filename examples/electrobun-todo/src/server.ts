import { furin } from "@teyik0/furin";
import { createDesktopApp } from "@teyik0/furin-electrobun/server";
import { closeTodoBackend, getTodoBackend } from "./backend-instance";

const backend = getTodoBackend();
const app = createDesktopApp()
  .use(backend.api)
  .use(await furin({ pagesDir: `${import.meta.dir}/pages`, sync: backend.sync }));

if (import.meta.main) {
  app.listen({ hostname: "127.0.0.1", port: Number(process.env.PORT ?? 3004) });
  console.log(`Furin todos: http://127.0.0.1:${app.server?.port}`);
}

export default app;
export const onShutdown = closeTodoBackend;
