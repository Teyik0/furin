import { defineRoute } from "@teyik0/furin";
import { home } from "../shared.ts";

export const route = defineRoute("/")
  .config({ mode: "ssg" })
  .loader(async ({ root }) => ({ home, root: await root }))
  .page(({ home: homeValue }) => String(homeValue));
