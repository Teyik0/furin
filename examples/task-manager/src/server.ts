import { furin } from "@teyik0/furin";
import Elysia from "elysia";
import { initLogger } from "evlog";
import { api } from "./api";
import { taskManagerSync } from "./sync";

initLogger({
  env: { service: "task-manager" },
  sampling: {
    keep: [{ status: 400 }, { duration: 1000 }],
    rates: { info: 10 },
  },
});

const app = new Elysia({ name: "task-manager" }).use(api).use(
  await furin({
    logger: {
      keep: (context) => {
        if (context.method !== "GET") {
          context.shouldKeep = true;
        }
      },
    },
    pagesDir: "./src/pages",
    sync: taskManagerSync,
  })
);

if (import.meta.main) {
  app.listen(Number(process.env.PORT ?? 3002));
  console.log(`Task Manager running at http://localhost:${app.server?.port}`);
}

export default app;
