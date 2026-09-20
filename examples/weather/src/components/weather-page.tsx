import { Link, useRouter } from "@teyik0/furin/link";
import { type FormEvent, useCallback } from "react";
import type { WeatherPageData } from "../api/weather-page";
import { POPULAR_CITIES, toCitySlug, weatherHrefForSlug } from "../lib/cities";
import { CurrentWeatherCard } from "./current-weather-card";
import { ForecastGrid } from "./forecast-grid";

interface WeatherPageProps {
  activeCitySlug: string;
  city: WeatherPageData["city"];
  error: WeatherPageData["error"];
  weather: WeatherPageData["weather"];
}

export function WeatherPage({ activeCitySlug, city, error, weather }: WeatherPageProps) {
  const { basePath, navigate } = useRouter();

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      const value = new FormData(event.currentTarget).get("city");
      if (typeof value !== "string") {
        return;
      }
      navigate(weatherHrefForSlug(toCitySlug(value)));
    },
    [navigate]
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-semibold text-3xl text-white tracking-tight">Weather</h1>
        <p className="mt-1 text-zinc-400">
          Powered by Open-Meteo &mdash; served from a single Bun process
        </p>
      </div>

      <form
        action={`${basePath}/weather/search`}
        className="flex gap-3"
        method="get"
        onSubmit={handleSubmit}
      >
        <input
          aria-label="City name"
          className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-white outline-none placeholder:text-zinc-500 focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/30"
          defaultValue={city}
          key={city}
          name="city"
          placeholder="Search city..."
          required
          type="text"
        />
        <button
          className="rounded-xl bg-cyan-500 px-5 py-2.5 font-medium text-sm text-white transition-colors hover:bg-cyan-400"
          type="submit"
        >
          Search
        </button>
      </form>

      <div className="flex flex-wrap gap-2">
        {POPULAR_CITIES.map(({ label, slug }) => {
          const className = `rounded-full border px-3 py-1 text-sm transition-colors ${
            activeCitySlug === slug
              ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200"
              : "border-white/10 bg-white/5 text-zinc-300 hover:border-white/20 hover:text-white"
          }`;

          if (slug === "paris") {
            return (
              <Link className={className} key={slug} preload="intent" to="/">
                {label}
              </Link>
            );
          }

          return (
            <Link
              className={className}
              key={slug}
              params={{ city: slug }}
              preload="intent"
              to="/weather/:city"
            >
              {label}
            </Link>
          );
        })}
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-400/20 bg-red-400/10 p-6 text-center">
          <p className="text-lg text-red-200">{error}</p>
          <p className="mt-2 text-red-300/70 text-sm">Try a different city name</p>
        </div>
      ) : null}

      {weather ? <CurrentWeatherCard weather={weather} /> : null}
      {weather ? <ForecastGrid daily={weather.daily} /> : null}
    </div>
  );
}
