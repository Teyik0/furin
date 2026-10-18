/**
 * Server-thrown error carrying an HTTP status and a server-computed digest
 * across SSR and SPA navigation.
 *
 * Why a class (not property-stamping):
 * - Mirrors the `FurinNotFoundError` pattern (consistency).
 * - Type-narrowable via `instanceof` and the brand check.
 * - Survives error wrappers (Sentry / monitoring libs that re-throw
 *   `new Error(original.message)` would strip property stamps).
 *
 * Used by:
 * - `FurinErrorBoundary.getDerivedStateFromError` — to honour the server's
 *   digest instead of recomputing one client-side (the latter would produce a
 *   different hash because the public message + synthetic stack differ from the
 *   original server-side error).
 */
const SERVER_ERROR_BRAND = "FURIN_SERVER_ERROR" as const;

export interface FurinServerErrorPayload {
  digest: string;
  message: string;
  status: number;
}

export class FurinServerError extends Error {
  readonly __furinBrand = SERVER_ERROR_BRAND;
  readonly digest: string;
  readonly status: number;

  constructor(args: FurinServerErrorPayload) {
    super(args.message);
    this.status = args.status;
    this.digest = args.digest;
  }
}

export function isFurinServerError(err: unknown): err is FurinServerError {
  return (
    err instanceof FurinServerError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { __furinBrand?: unknown }).__furinBrand === SERVER_ERROR_BRAND)
  );
}
