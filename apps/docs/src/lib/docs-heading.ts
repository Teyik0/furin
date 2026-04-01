export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

export function getUniqueHeadingId(text: string, seen: Map<string, number>): string {
  const baseId = slugifyHeading(text);
  const count = seen.get(baseId) ?? 0;

  seen.set(baseId, count + 1);

  return count === 0 ? baseId : `${baseId}-${count + 1}`;
}
