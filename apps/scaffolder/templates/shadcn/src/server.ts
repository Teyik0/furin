import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import { getHelloPayload } from "./api/hello";

const port = Number(process.env.PORT ?? 3000);

const app = new Elysia()
  .get("/api/hello", () => getHelloPayload())
  .use(
    await furin({
      pagesDir: "./src/pages",
    })
  )
  .listen(port);

console.log(`{{PROJECT_NAME}} running at http://localhost:${app.server?.port}`);
