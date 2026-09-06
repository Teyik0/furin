import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import { api } from "./api";
import { taskManagerSync } from "./sync";

const port = Number(process.env.PORT ?? 3002);

const app = new Elysia()
  .use(
    await furin({
      logger: {
        keep: (context) => {
          if (context.method !== "GET") {
            context.shouldKeep = true;
          }
        },
        sampling: {
          keep: [{ status: 400 }, { duration: 1000 }],
          rates: { info: 10 },
        },
      },
      pagesDir: "./src/pages",
      sync: taskManagerSync,
    })
  )
  .use(api)
  .listen(port);

console.log(`Task Manager running at http://localhost:${app.server?.port}`);
