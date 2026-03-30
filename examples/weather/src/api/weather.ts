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

async function geocode(city: string): Promise<GeoResult | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`;
  const res = await fetch(url);
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
    name: result.name,
    country: result.country,
    latitude: result.latitude,
    longitude: result.longitude,
  };
}

async function fetchForecast(
  lat: number,
  lon: number
): Promise<{ current: CurrentWeather; daily: DailyForecast[] }> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto`;
  const res = await fetch(url);
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

export async function getWeather(city: string): Promise<WeatherResponse | null> {
  const geo = await geocode(city);
  if (!geo) {
    return null;
  }

  const forecast = await fetchForecast(geo.latitude, geo.longitude);

  return {
    city: geo.name,
    country: geo.country,
    current: forecast.current,
    daily: forecast.daily,
  };
}
