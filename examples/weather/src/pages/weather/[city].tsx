import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { loadWeatherPage } from "../../api/weather-page";
import { WeatherPage } from "../../components/weather-page";
import { cityNameFromSlug, POPULAR_CITIES } from "../../lib/cities";
import { route as parentRoute } from "../root";

export const route = defineRoute()
  .config({
    layout: parentRoute,
    mode: "isr",
    params: t.Object({ city: t.String({ minLength: 1 }) }),
    revalidate: 300,
    staticParams: () =>
      POPULAR_CITIES.filter(({ slug }) => slug !== "paris").map(({ slug }) => ({ city: slug })),
  })
  .loader(({ log, params, redirect }) => {
    if (params.city.toLocaleLowerCase("en") === "paris") {
      throw redirect("/");
    }
    return loadWeatherPage(cityNameFromSlug(params.city), log);
  })
  .head(({ city }) => ({
    meta: [{ title: `Weather in ${city}` }],
  }))
  .page(({ city, error, params, weather }) => (
    <WeatherPage activeCitySlug={params.city} city={city} error={error} weather={weather} />
  ));
