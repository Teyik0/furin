import { getWeather, type WeatherLogger } from "./weather";

export function formatForecastWeekday(date: string): string {
  return new Date(date).toLocaleDateString("en", {
    timeZone: "UTC",
    weekday: "short",
  });
}

export async function loadWeatherPage(city: string, logger: WeatherLogger) {
  const data = await getWeather(city, logger);

  if (data === null) {
    return { city, error: `City not found: "${city}"`, weather: null };
  }

  const dailyWithDayName = data.daily.map((day) => ({
    ...day,
    dayName: formatForecastWeekday(day.date),
  }));

  return {
    city: data.city,
    error: null,
    weather: { ...data, daily: dailyWithDayName },
  };
}

export type WeatherPageData = Awaited<ReturnType<typeof loadWeatherPage>>;
