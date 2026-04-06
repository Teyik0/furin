import { Elysia } from "elysia";
import { boardPlugin } from "./modules/boards";
import { cardPlugin } from "./modules/cards";

export const api = new Elysia({ prefix: "/api" }).use(boardPlugin).use(cardPlugin);

export type Api = typeof api;
