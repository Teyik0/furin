import Elysia from "elysia";
import { authPlugin } from "./auth";
import { commentsPlugin } from "./comments";

export const api = new Elysia().use(authPlugin).use(commentsPlugin);

export type Api = typeof api;
