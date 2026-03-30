interface WeatherCondition {
  emoji: string;
  label: string;
}

const WEATHER_CODES: Record<number, WeatherCondition> = {
  0: { label: "Clear sky", emoji: "\u2600\uFE0F" },
  1: { label: "Mainly clear", emoji: "\uD83C\uDF24\uFE0F" },
  2: { label: "Partly cloudy", emoji: "\u26C5" },
  3: { label: "Overcast", emoji: "\u2601\uFE0F" },
  45: { label: "Fog", emoji: "\uD83C\uDF2B\uFE0F" },
  48: { label: "Rime fog", emoji: "\uD83C\uDF2B\uFE0F" },
  51: { label: "Light drizzle", emoji: "\uD83C\uDF26\uFE0F" },
  53: { label: "Moderate drizzle", emoji: "\uD83C\uDF26\uFE0F" },
  55: { label: "Dense drizzle", emoji: "\uD83C\uDF27\uFE0F" },
  61: { label: "Slight rain", emoji: "\uD83C\uDF27\uFE0F" },
  63: { label: "Moderate rain", emoji: "\uD83C\uDF27\uFE0F" },
  65: { label: "Heavy rain", emoji: "\uD83C\uDF27\uFE0F" },
  71: { label: "Slight snow", emoji: "\uD83C\uDF28\uFE0F" },
  73: { label: "Moderate snow", emoji: "\u2744\uFE0F" },
  75: { label: "Heavy snow", emoji: "\u2744\uFE0F" },
  77: { label: "Snow grains", emoji: "\uD83C\uDF28\uFE0F" },
  80: { label: "Light showers", emoji: "\uD83C\uDF26\uFE0F" },
  81: { label: "Moderate showers", emoji: "\uD83C\uDF27\uFE0F" },
  82: { label: "Violent showers", emoji: "\u26C8\uFE0F" },
  85: { label: "Light snow showers", emoji: "\uD83C\uDF28\uFE0F" },
  86: { label: "Heavy snow showers", emoji: "\u2744\uFE0F" },
  95: { label: "Thunderstorm", emoji: "\u26C8\uFE0F" },
  96: { label: "Thunderstorm with hail", emoji: "\u26C8\uFE0F" },
  99: { label: "Thunderstorm with heavy hail", emoji: "\u26C8\uFE0F" },
};

export function getWeatherCondition(code: number): WeatherCondition {
  return WEATHER_CODES[code] ?? { label: "Unknown", emoji: "\u2753" };
}
