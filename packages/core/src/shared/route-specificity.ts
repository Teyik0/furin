function segmentSpecificity(segment: string): number {
  if (segment === "*") {
    return 1;
  }
  return segment.startsWith(":") ? 2 : 3;
}

/** Positive when a is more specific: literal > parameter > catch-all. */
export function compareRouteSpecificity(a: string, b: string): number {
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
