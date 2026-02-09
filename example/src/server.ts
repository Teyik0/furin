import { Elysia } from "elysia";
import { elysion } from "elysion";

const app = new Elysia()
  .use(
    elysion({
      pagesDir: `${import.meta.dir}/pages`,
      staticOptions: {
        assets: `${import.meta.dir}/../public`,
        prefix: "/public",
        staticLimit: 1024,
        alwaysStatic: process.env.NODE_ENV === "production",
      },
    })
  )
  .group("/api", (api) =>
    api
      .get("/health", () => ({ status: "ok", uptime: process.uptime() }))
      .get("/posts", () => ({
        posts: [
          { slug: "hello-world", title: "Hello World" },
          { slug: "elysia-rocks", title: "Elysia Rocks" },
        ],
      }))
  )
  .listen(3000);

console.log(
  `\n🦊 elysia-react-ssr example running at http://localhost:${app.server?.port}\n`
);
