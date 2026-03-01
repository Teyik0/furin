import { elysion } from "@teyik0/elysion";
import Elysia from "elysia";
import { api } from "./api";

const formattedDate = () =>
  new Date().toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

const requestStartTimes = new WeakMap<Request, number>();

const app = new Elysia()
  .onTransform(({ body, params, path, request }) => {
    requestStartTimes.set(request, performance.now());
    console.log(`${formattedDate()} - ${request.method} ${path}`, {
      body,
      params,
    });
  })
  .onAfterResponse(({ path, set, request }) => {
    const startedAt = requestStartTimes.get(request) ?? performance.now();
    console.log(`${formattedDate()} - RESPONSE ${path}`, {
      performance: `${(performance.now() - startedAt).toFixed(2)} ms`,
      status: set.status,
    });
    requestStartTimes.delete(request);
  })
  .use(api)
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
