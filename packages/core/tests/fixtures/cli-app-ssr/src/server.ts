import { furin } from "@teyik0/furin";
import Elysia from "elysia";

const port = Number(process.env.PORT ?? 3111);

const app = new Elysia()
  .use(
    await furin({
      pagesDir: `${import.meta.dir}/pages`,
    })
  )
  .listen(port);

console.log(`[test-app] listening on ${app.server?.port}`);
