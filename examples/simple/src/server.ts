import { elyra } from "elyra";
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
  .onTransform(({ request }) => {
    requestStartTimes.set(request, performance.now());
  })
  .onAfterResponse(({ path, request }) => {
    const startedAt = requestStartTimes.get(request) ?? performance.now();
    console.log(`${formattedDate()} - ${path} - ${(performance.now() - startedAt).toFixed(2)} ms`);
    requestStartTimes.delete(request);
  })
  .use(api)
  .use(
    await elyra({
      pagesDir: "./src/pages",
    })
  )
  .listen(3000);

console.log(`\nElyra Blog + Dashboard running at http://localhost:${app.server?.port}`);
console.log("Initial cold start: ", performance.now().toFixed(2), "ms");
