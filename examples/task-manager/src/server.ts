import { furin } from "@teyik0/furin";
import { api } from "./api";
import { taskManagerSync } from "./sync";

const app = api.use(
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
);

if (import.meta.main) {
  app.listen(Number(process.env.PORT ?? 3002));
  console.log(`Task Manager running at http://localhost:${app.server?.port}`);
}

export default app;
