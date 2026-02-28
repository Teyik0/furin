import { elysion } from "@teyik0/elysion";
import Elysia from "elysia";
import { api } from "./api";

const app = new Elysia()
  .use(api)
  .onBeforeHandle(({ request }) => console.log("USER REQ - ", request.url))
  .use(
    await elysion({
      pagesDir: `${import.meta.dir}/pages`,
      staticOptions: {
        assets: `${import.meta.dir}/../public`,
        prefix: "/public",
        staticLimit: 1024,
        alwaysStatic: process.env.NODE_ENV === "production",
      },
    })
  )
  .listen(3000);

console.log(`\n Elysion Blog + Dashboard running at http://localhost:${app.server?.port}`);
console.log("\nTest accounts:");
console.log("  user@example.com (role: user)");
console.log("  admin@example.com (role: admin)");
