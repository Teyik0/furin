interface FingerprintInput {
  body: unknown;
  request: Request;
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

export function sha256Hex(source: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(source);
  return hasher.digest("hex");
}

export function createMutationFingerprint(input: FingerprintInput): string {
  const url = new URL(input.request.url);
  url.searchParams.sort();
  const query = [...url.searchParams.entries()];
  const source = JSON.stringify({
    body: canonicalize(input.body) ?? null,
    contentType: input.request.headers.get("content-type") ?? "",
    method: input.request.method,
    pathname: url.pathname,
    query,
  });
  return sha256Hex(source);
}
