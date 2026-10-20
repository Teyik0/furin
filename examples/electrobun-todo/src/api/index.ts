import { furinSync } from "@teyik0/furin";
import { Elysia } from "elysia";
import { sync } from "../sync";
import { todoPlugin } from "./modules/todos";

export const api = new Elysia({ name: "relay-api", prefix: "/api" })
  .use(furinSync(sync))
  .use(todoPlugin);
export type Api = typeof api;

declare module "@teyik0/furin" {
  interface Register {
    app: typeof api;
  }
}
