import { Elysia } from "elysia";

export const route = {
  elysia: new Elysia().get("/", () => "hyphen"),
};
