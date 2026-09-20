export const POPULAR_CITIES = [
  { label: "Paris", slug: "paris" },
  { label: "Tokyo", slug: "tokyo" },
  { label: "New York", slug: "new-york" },
  { label: "London", slug: "london" },
  { label: "Sydney", slug: "sydney" },
  { label: "Dubai", slug: "dubai" },
] as const;

const DIACRITIC_RE = /\p{Diacritic}/gu;
const NON_SLUG_CHARACTER_RE = /[^a-z0-9]+/g;
const OUTER_DASH_RE = /^-+|-+$/g;

export function cityNameFromSlug(slug: string): string {
  const popularCity = POPULAR_CITIES.find((city) => city.slug === slug);
  if (popularCity) {
    return popularCity.label;
  }
  try {
    return decodeURIComponent(slug).replaceAll("-", " ");
  } catch {
    return slug.replaceAll("-", " ");
  }
}

export function toCitySlug(city: string): string {
  const trimmedCity = city.trim();
  if (trimmedCity.length === 0) {
    return "paris";
  }
  const slug = trimmedCity
    .normalize("NFKD")
    .replace(DIACRITIC_RE, "")
    .toLocaleLowerCase("en")
    .replace(NON_SLUG_CHARACTER_RE, "-")
    .replace(OUTER_DASH_RE, "");

  return slug.length > 0 ? slug : encodeURIComponent(trimmedCity);
}

export function weatherHrefForSlug(slug: string): string {
  return slug === "paris" ? "/" : `/weather/${slug}`;
}
