import { afterAll, expect, test } from "bun:test";
import { furin } from "@teyik0/furin";
import { getCache } from "@teyik0/furin/cache";
import { Elysia } from "elysia";
import { cityNameFromSlug, toCitySlug } from "../src/lib/cities.ts";
import { route as cityRoute } from "../src/pages/weather/[city].tsx";
import app from "../src/server.ts";

const prefixedApp = new Elysia().use(await furin({ pagesDir: "./src/pages", prefix: "/forecast" }));
const weatherCache = getCache({ namespace: "furin-weather-v1" });
const city = "Routeville";
const latitude = 47.25;
const longitude = 1.5;
const parisLatitude = 48.8566;
const parisLongitude = 2.3522;

async function primeWeatherCache(
  cityName: string,
  cityLatitude: number,
  cityLongitude: number
): Promise<void> {
  await weatherCache.set(`geocode:${cityName.toLocaleLowerCase("en")}`, {
    country: "France",
    latitude: cityLatitude,
    longitude: cityLongitude,
    name: cityName,
  });
  await weatherCache.set(`forecast:${cityLatitude}:${cityLongitude}`, {
    current: {
      temperature: 18,
      weatherCode: 1,
      windSpeed: 8,
    },
    daily: [
      {
        date: "2026-09-19",
        temperatureMax: 20,
        temperatureMin: 10,
        weatherCode: 1,
      },
    ],
  });
}

afterAll(async () => {
  await weatherCache.delete(`geocode:${city.toLocaleLowerCase("en")}`);
  await weatherCache.delete(`forecast:${latitude}:${longitude}`);
  await weatherCache.delete("geocode:paris");
  await weatherCache.delete(`forecast:${parisLatitude}:${parisLongitude}`);
});

test("keeps forecast weekdays stable across server time zones", async () => {
  const moduleUrl = new URL("../src/api/weather-page.ts", import.meta.url).href;
  const script = `import { formatForecastWeekday } from ${JSON.stringify(moduleUrl)}; console.log(formatForecastWeekday("2026-09-19"));`;
  const process = Bun.spawn(["bun", "-e", script], {
    env: { ...Bun.env, TZ: "America/Los_Angeles" },
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(await new Response(process.stdout).text()).toBe("Sat\n");
  expect(await process.exited).toBe(0);
});

test("renders a city route directly without redirecting", async () => {
  await primeWeatherCache(city, latitude, longitude);

  const response = await app.handle(
    new Request(`http://localhost/weather/${city.toLocaleLowerCase("en")}`)
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  const html = await response.text();
  expect(html).toContain("18<!-- -->°C");
  expect(html).not.toContain("City not found");
});

test("keeps the no-JavaScript search action inside a mount prefix", async () => {
  await primeWeatherCache("Paris", parisLatitude, parisLongitude);

  const response = await prefixedApp.handle(new Request("http://localhost/forecast/"));

  expect(response.status).toBe(200);
  expect(await response.text()).toContain('action="/forecast/weather/search"');
});

test("redirects the duplicate Paris city route to the canonical root", async () => {
  const response = await app.handle(new Request("http://localhost/weather/paris"));

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/");
});

test("renders Paris at the root without depending on search params", async () => {
  await primeWeatherCache("Paris", parisLatitude, parisLongitude);
  await primeWeatherCache(city, latitude, longitude);

  const response = await app.handle(new Request(`http://localhost/?city=${city}`));
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(html).toContain("<title>Weather in Paris</title>");
  expect(html).not.toContain(`<title>Weather in ${city}</title>`);
});

test("declares popular city paths for build-time ISR prerendering", async () => {
  expect(await cityRoute.staticParams?.({ params: {} })).toEqual([
    { city: "tokyo" },
    { city: "new-york" },
    { city: "london" },
    { city: "sydney" },
    { city: "dubai" },
  ]);
});

test("keeps a no-JavaScript search fallback away from the initial page", async () => {
  const response = await app.handle(new Request("http://localhost/weather/search?city=New%20York"));

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/weather/new-york");
});

test("preserves non-Latin city names in path segments", () => {
  const slug = toCitySlug("東京");

  expect(slug).toBe("%E6%9D%B1%E4%BA%AC");
  expect(cityNameFromSlug(slug)).toBe("東京");
});
