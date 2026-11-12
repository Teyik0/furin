import { defineRoute } from "@teyik0/furin";
import { loadWeatherPage } from "../api/weather-page";
import { WeatherPage } from "../components/weather-page";

export const route = defineRoute("/")
  .config({
    mode: "isr",
    revalidate: 300,
  })
  .loader(({ log }) => loadWeatherPage("Paris", log))
  .head(() => ({
    meta: [{ title: "Weather in Paris" }],
  }))
  .page(({ city, error, weather }) => (
    <WeatherPage activeCitySlug="paris" city={city} error={error} weather={weather} />
  ));
