import { defineRoute } from "@teyik0/furin";
import { Link } from "@teyik0/furin/link";
import { t } from "elysia";
import type { WeatherResponse } from "../api/weather";
import { CurrentWeatherCard } from "../components/current-weather-card";
import { ForecastGrid } from "../components/forecast-grid";
import { route as parentRoute } from "./root";

const POPULAR_CITIES = ["Paris", "Tokyo", "New York", "London", "Sydney", "Dubai"];

export const route = defineRoute()
  .config({
    layout: parentRoute,
    mode: "ssr",
    query: t.Object({ city: t.String({ default: "Paris" }) }),
  })
  .loader(async ({ query, request }) => {
    const { city } = query;
    const url = new URL(`/api/weather?city=${encodeURIComponent(city)}`, request.url);
    const res = await fetch(url);
    if (!res.ok) {
      return { city, error: `Weather API error (${res.status})`, weather: null };
    }
    const data = (await res.json()) as WeatherResponse | null;

    if (!data) {
      return { city, error: `City not found: "${city}"`, weather: null };
    }

    const dailyWithDayName = data.daily.map((day) => ({
      ...day,
      dayName: new Date(day.date).toLocaleDateString("en", { weekday: "short" }),
    }));

    return { city, error: null, weather: { ...data, daily: dailyWithDayName } };
  })
  .head(({ query }) => ({
    meta: [{ title: `Weather in ${query.city ?? "Paris"}` }],
  }))
  .page(({ data: { weather, city, error } }) => {
    return (
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="font-semibold text-3xl text-white tracking-tight">Weather</h1>
          <p className="mt-1 text-zinc-400">
            Powered by Open-Meteo &mdash; served from a single Bun process
          </p>
        </div>

        {/* Search */}
        {/* Native GET form: submits to /?city=<value>, which the loader
            reads via query.city. Works with JavaScript disabled. */}
        <form action="/" className="flex gap-3" method="get">
          <input
            aria-label="City name"
            className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-white outline-none placeholder:text-zinc-500 focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/30"
            defaultValue={city}
            key={city}
            name="city"
            placeholder="Search city..."
            type="text"
          />
          <button
            className="rounded-xl bg-cyan-500 px-5 py-2.5 font-medium text-sm text-white transition-colors hover:bg-cyan-400"
            type="submit"
          >
            Search
          </button>
        </form>

        {/* Popular cities */}
        <div className="flex flex-wrap gap-2">
          {POPULAR_CITIES.map((c) => (
            <Link
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                city === c
                  ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200"
                  : "border-white/10 bg-white/5 text-zinc-300 hover:border-white/20 hover:text-white"
              }`}
              key={c}
              search={{ city: c }}
              to="/"
            >
              {c}
            </Link>
          ))}
        </div>

        {/* Error state */}
        {error ? (
          <div className="rounded-2xl border border-red-400/20 bg-red-400/10 p-6 text-center">
            <p className="text-lg text-red-200">{error}</p>
            <p className="mt-2 text-red-300/70 text-sm">Try a different city name</p>
          </div>
        ) : null}

        {/* Current weather */}
        {weather ? <CurrentWeatherCard weather={weather} /> : null}

        {/* 7-day forecast */}
        {weather ? <ForecastGrid daily={weather.daily} /> : null}
      </div>
    );
  });
