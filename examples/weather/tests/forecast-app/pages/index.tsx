import { defineRoute } from "@teyik0/furin";
import { loadWeatherPage } from "../../../src/api/weather-page";
import { WeatherPage } from "../../../src/components/weather-page";

export const route = defineRoute("/forecast")
  .config({ mode: "ssr" })
  .loader(({ log }) => loadWeatherPage("Paris", log))
  .page(({ city, error, weather }) => (
    <WeatherPage activeCitySlug="paris" city={city} error={error} weather={weather} />
  ));
