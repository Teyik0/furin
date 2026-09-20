import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { toCitySlug, weatherHrefForSlug } from "../../lib/cities";
import { route as parentRoute } from "../root";

export const route = defineRoute()
  .config({
    layout: parentRoute,
    mode: "ssr",
    query: t.Object({ city: t.String({ minLength: 1 }) }),
  })
  .loader(({ query, redirect }) => {
    throw redirect(weatherHrefForSlug(toCitySlug(query.city)));
  })
  .page(() => null);
