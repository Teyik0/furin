import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import { initLogger } from "evlog";

initLogger({ env: { service: "weather" } });

const app = new Elysia().use(await furin({ pagesDir: "./src/pages" }));
export const port = Number(process.env.PORT ?? 3001);

if (import.meta.main) {
  app.listen(port);
  console.log(`Weather app running at http://localhost:${app.server?.port}`);
}

export default app;
