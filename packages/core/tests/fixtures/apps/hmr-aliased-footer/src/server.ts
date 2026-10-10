import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";

new Elysia()
  .use(await furin({ pagesDir: `${import.meta.dir}/pages` }))
  .listen(Number(process.env.PORT ?? 3111));

console.log("footer-fixture-started");
