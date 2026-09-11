import { afterEach, expect, mock, test } from "bun:test";
import { getWeather, type WeatherTiming } from "../src/api/weather.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("getWeather reuses geocoding and forecast data and reports cache timings", async () => {
  const fetchMock = mock((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("geocoding-api")) {
      return Promise.resolve(
        Response.json({
          results: [
            {
              country: "France",
              latitude: 48.8566,
              longitude: 2.3522,
              name: "Cacheville",
            },
          ],
        })
      );
    }
    return Promise.resolve(
      Response.json({
        current: {
          temperature_2m: 18,
          weather_code: 1,
          wind_speed_10m: 8,
        },
        daily: {
          temperature_2m_max: [20],
          temperature_2m_min: [10],
          time: ["2026-09-11"],
          weather_code: [1],
        },
      })
    );
  });
  globalThis.fetch = fetchMock as typeof fetch;
  const timings: WeatherTiming[] = [];
  const logger = {
    set(fields: { weather: WeatherTiming }) {
      timings.push(fields.weather);
    },
  };

  const first = await getWeather("Cacheville", logger);
  const second = await getWeather("Cacheville", logger);

  expect(first).toEqual(second);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(timings).toHaveLength(2);
  expect(timings[0]?.geocode_cache).toBe("miss");
  expect(timings[0]?.forecast_cache).toBe("miss");
  expect(timings[1]?.geocode_cache).toBe("hit");
  expect(timings[1]?.forecast_cache).toBe("hit");
  expect(timings[1]?.total_ms).toBeLessThanOrEqual(timings[0]?.total_ms ?? 0);
});
