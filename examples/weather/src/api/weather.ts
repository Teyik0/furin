import { getCache } from "@vercel/functions";

export interface GeoResult {
  country: string;
  latitude: number;
  longitude: number;
  name: string;
}

export interface CurrentWeather {
  temperature: number;
  weatherCode: number;
  windSpeed: number;
}

export interface DailyForecast {
  date: string;
  temperatureMax: number;
  temperatureMin: number;
  weatherCode: number;
}

export interface WeatherResponse {
  city: string;
  country: string;
  current: CurrentWeather;
  daily: DailyForecast[];
}

interface ForecastResult {
  current: CurrentWeather;
  daily: DailyForecast[];
}

type WeatherCacheStatus = "hit" | "miss" | "skipped";

export interface WeatherTiming {
  forecast_cache: WeatherCacheStatus;
  forecast_ms: number;
  geocode_cache: Exclude<WeatherCacheStatus, "skipped">;
  geocode_ms: number;
  total_ms: number;
}

export interface WeatherLogger {
  set: (fields: { weather: WeatherTiming }) => void;
}

const FORECAST_TTL_SECONDS = 300;
const GEOCODE_TTL_SECONDS = 86_400;
const weatherCache = getCache({ namespace: "furin-weather-v1" });

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function isGeoResult(value: unknown): value is GeoResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<GeoResult>;
  return (
    typeof candidate.country === "string" &&
    typeof candidate.latitude === "number" &&
    typeof candidate.longitude === "number" &&
    typeof candidate.name === "string"
  );
}

function isCurrentWeather(value: unknown): value is CurrentWeather {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<CurrentWeather>;
  return (
    typeof candidate.temperature === "number" &&
    typeof candidate.weatherCode === "number" &&
    typeof candidate.windSpeed === "number"
  );
}

function isDailyForecast(value: unknown): value is DailyForecast {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<DailyForecast>;
  return (
    typeof candidate.date === "string" &&
    typeof candidate.temperatureMax === "number" &&
    typeof candidate.temperatureMin === "number" &&
    typeof candidate.weatherCode === "number"
  );
}

function isForecastResult(value: unknown): value is ForecastResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ForecastResult>;
  return (
    isCurrentWeather(candidate.current) &&
    Array.isArray(candidate.daily) &&
    candidate.daily.every(isDailyForecast)
  );
}

async function readCache(key: string): Promise<unknown | null> {
  try {
    return await weatherCache.get(key);
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: unknown, ttl: number): Promise<void> {
  try {
    await weatherCache.set(key, value, { name: key, ttl });
  } catch {
    // Cache availability must never become a weather-service dependency.
  }
}

async function geocode(city: string): Promise<GeoResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`;
  const res = await fetch(url);
  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as {
    results?: Array<{
      name: string;
      country: string;
      latitude: number;
      longitude: number;
    }>;
  };

  const result = json.results?.[0];
  if (!result) {
    return null;
  }

  return {
    country: result.country,
    latitude: result.latitude,
    longitude: result.longitude,
    name: result.name,
  };
}

async function fetchForecast(lat: number, lon: number): Promise<ForecastResult> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Weather API error (${res.status})`);
  }
  const json = (await res.json()) as {
    current: {
      temperature_2m: number;
      weather_code: number;
      wind_speed_10m: number;
    };
    daily: {
      time: string[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      weather_code: number[];
    };
  };

  return {
    current: {
      temperature: json.current.temperature_2m,
      weatherCode: json.current.weather_code,
      windSpeed: json.current.wind_speed_10m,
    },
    daily: json.daily.time.map((date: string, i: number) => ({
      date,
      temperatureMax: json.daily.temperature_2m_max[i] ?? 0,
      temperatureMin: json.daily.temperature_2m_min[i] ?? 0,
      weatherCode: json.daily.weather_code[i] ?? 0,
    })),
  };
}

async function getCachedGeocode(
  city: string
): Promise<{ cache: "hit" | "miss"; value: GeoResult | null }> {
  const key = `geocode:${city.trim().toLocaleLowerCase("en")}`;
  const cached = await readCache(key);
  if (isGeoResult(cached)) {
    return { cache: "hit", value: cached };
  }
  const value = await geocode(city);
  if (value !== null) {
    await writeCache(key, value, GEOCODE_TTL_SECONDS);
  }
  return { cache: "miss", value };
}

async function getCachedForecast(
  latitude: number,
  longitude: number
): Promise<{ cache: "hit" | "miss"; value: ForecastResult }> {
  const key = `forecast:${latitude}:${longitude}`;
  const cached = await readCache(key);
  if (isForecastResult(cached)) {
    return { cache: "hit", value: cached };
  }
  const value = await fetchForecast(latitude, longitude);
  await writeCache(key, value, FORECAST_TTL_SECONDS);
  return { cache: "miss", value };
}

export async function getWeather(
  city: string,
  logger: WeatherLogger
): Promise<WeatherResponse | null> {
  const startedAt = performance.now();
  const timing: WeatherTiming = {
    forecast_cache: "skipped",
    forecast_ms: 0,
    geocode_cache: "miss",
    geocode_ms: 0,
    total_ms: 0,
  };

  try {
    const geocodeStartedAt = performance.now();
    const geocodeResult = await getCachedGeocode(city);
    timing.geocode_cache = geocodeResult.cache;
    timing.geocode_ms = elapsedMs(geocodeStartedAt);
    if (geocodeResult.value === null) {
      return null;
    }

    const forecastStartedAt = performance.now();
    const forecastResult = await getCachedForecast(
      geocodeResult.value.latitude,
      geocodeResult.value.longitude
    );
    timing.forecast_cache = forecastResult.cache;
    timing.forecast_ms = elapsedMs(forecastStartedAt);

    return {
      city: geocodeResult.value.name,
      country: geocodeResult.value.country,
      current: forecastResult.value.current,
      daily: forecastResult.value.daily,
    };
  } finally {
    timing.total_ms = elapsedMs(startedAt);
    logger.set({ weather: timing });
  }
}
