function segmentSpecificity(segment: string): number {
  if (segment === "*") {
    return 1;
  }
  return segment.startsWith(":") ? 2 : 3;
}

/** Literal > parameter > catch-all, on patterns without optional segments. */
function compareConcreteSpecificity(a: string, b: string): number {
  const aSegments = a.split("/").filter(Boolean);
  const bSegments = b.split("/").filter(Boolean);
  const length = Math.max(aSegments.length, bSegments.length);
  for (let index = 0; index < length; index += 1) {
    const aSegment = aSegments[index];
    const bSegment = bSegments[index];
    if (aSegment === undefined) {
      return bSegment === "*" ? 1 : -1;
    }
    if (bSegment === undefined) {
      return aSegment === "*" ? -1 : 1;
    }
    const difference = segmentSpecificity(aSegment) - segmentSpecificity(bSegment);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * The concrete patterns an optional `:x?` segment stands for, as Elysia
 * registers them: `/:lang?/about` → `/about` and `/:lang/about`.
 */
export function expandOptionalSegments(pattern: string): string[] {
  let variants: string[][] = [[]];
  for (const segment of pattern.split("/").filter(Boolean)) {
    if (segment.startsWith(":") && segment.endsWith("?")) {
      const required = segment.slice(0, -1);
      variants = variants.flatMap((variant) => [variant, [...variant, required]]);
    } else {
      variants = variants.map((variant) => [...variant, segment]);
    }
  }
  return variants.map((variant) => `/${variant.join("/")}`);
}

function mostSpecificVariant(pattern: string): string {
  return expandOptionalSegments(pattern).reduce((best, variant) =>
    compareConcreteSpecificity(variant, best) > 0 ? variant : best
  );
}

/**
 * Positive when a is more specific: literal > parameter > catch-all. A
 * pattern with optional segments ranks as its most specific variant, so
 * `/:lang?/about` serves `/about` before `/:id` does, as on the server.
 */
export function compareRouteSpecificity(a: string, b: string): number {
  return compareConcreteSpecificity(mostSpecificVariant(a), mostSpecificVariant(b));
}
