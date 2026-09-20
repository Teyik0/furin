import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";

const app = new Elysia().use(await furin({ pagesDir: "./src/pages" }));

if (import.meta.main) {
  app.listen(Number(process.env.PORT ?? 3001));
  console.log(`Weather app running at http://localhost:${app.server?.port}`);
}

export default app;
