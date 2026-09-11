import { furin } from "@teyik0/furin";
import { Elysia, t } from "elysia";
import { createLogger } from "evlog";
import { getWeather } from "./api/weather";

const port = Number(process.env.PORT ?? 3001);

const app = new Elysia()
  .get(
    "/api/weather",
    async ({ query, request, set }) => {
      const startedAt = performance.now();
      const log = createLogger({ method: request.method, path: "/api/weather" });
      let status = 500;
      try {
        const weather = await getWeather(query.city, log);
        set.headers["cache-control"] =
          "public, max-age=0, must-revalidate, s-maxage=300, stale-while-revalidate=300";
        set.headers["cache-tag"] = "/api/weather";
        status = 200;
        return weather;
      } catch (error) {
        log.error(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        log.set({ durationMs: performance.now() - startedAt, status });
        log.emit();
      }
    },
    {
      query: t.Object({ city: t.String({ default: "Paris" }) }),
    }
  )
  .use(await furin({ pagesDir: "./src/pages" }));

export function startServer() {
  app.listen(port);
  console.log(`Weather app running at http://localhost:${app.server?.port}`);
  return app;
}

if (import.meta.main) {
  startServer();
}

export default app;
