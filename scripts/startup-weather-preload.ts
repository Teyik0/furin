// Keep external network latency out of the framework startup budget.
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === "geocoding-api.open-meteo.com") {
      return Promise.resolve(
        Response.json({
          results: [
            {
              country: "France",
              latitude: 48.86,
              longitude: 2.35,
              name: url.searchParams.get("name"),
            },
          ],
        })
      );
    }
    if (url.hostname === "api.open-meteo.com") {
      return Promise.resolve(
        Response.json({
          current: { temperature_2m: 18, weather_code: 0, wind_speed_10m: 8 },
          daily: {
            temperature_2m_max: [20],
            temperature_2m_min: [12],
            time: ["2026-01-01"],
            weather_code: [0],
          },
        })
      );
    }
    return originalFetch(input, init);
  },
  { preconnect: originalFetch.preconnect }
);
