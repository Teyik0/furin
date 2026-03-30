import { furin } from "@teyik0/furin";
import { Elysia, t } from "elysia";
import { getWeather } from "./api/weather";

const port = Number(process.env.PORT ?? 3001);

const app = new Elysia()
  .get("/api/weather", ({ query }) => getWeather(query.city), {
    query: t.Object({ city: t.String({ default: "Paris" }) }),
  })
  .use(await furin({ pagesDir: "./src/pages" }))
  .listen(port);

console.log(`Weather app running at http://localhost:${app.server?.port}`);
