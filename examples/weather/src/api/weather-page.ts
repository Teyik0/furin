import { getWeather, type WeatherLogger } from "./weather";

export async function loadWeatherPage(city: string, logger: WeatherLogger) {
  const data = await getWeather(city, logger);

  if (data === null) {
    return { city, error: `City not found: "${city}"`, weather: null };
  }

  const dailyWithDayName = data.daily.map((day) => ({
    ...day,
    dayName: new Date(day.date).toLocaleDateString("en", { weekday: "short" }),
  }));

  return {
    city: data.city,
    error: null,
    weather: { ...data, daily: dailyWithDayName },
  };
}

export type WeatherPageData = Awaited<ReturnType<typeof loadWeatherPage>>;
