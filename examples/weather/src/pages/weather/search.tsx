import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { toCitySlug, weatherHrefForSlug } from "../../lib/cities";

export const route = defineRoute("/weather/search")
  .config({
    mode: "ssr",
    query: t.Object({ city: t.String({ minLength: 1 }) }),
  })
  .loader(({ query, redirect }) => {
    throw redirect(weatherHrefForSlug(toCitySlug(query.city)));
  })
  .page(() => null);
