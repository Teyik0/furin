import { Elysia } from "elysia";

export interface FurinCspOptions {
  policy: (nonce: string | undefined) => string;
  reportOnly?: boolean;
}

const requestNonces = new WeakMap<Request, string>();
const usedNonces = new WeakSet<Request>();

/** @internal Called only by live SSR, never by public SSG/ISR prerenders. */
export function useRequestCspNonce(request: Request): string | undefined {
  const nonce = requestNonces.get(request);
  if (nonce !== undefined) {
    usedNonces.add(request);
  }
  return nonce;
}

/** Install before Furin routes to attach an application-owned CSP to HTML responses. */
export function furinCsp({ policy, reportOnly }: FurinCspOptions) {
  const header = reportOnly ? "content-security-policy-report-only" : "content-security-policy";
  return new Elysia()
    .beforeHandle("plugin", ({ request }) => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      requestNonces.set(request, btoa(String.fromCharCode(...bytes)));
    })
    .afterHandle("plugin", ({ request, responseValue, set }) => {
      const contentType =
        responseValue instanceof Response
          ? (responseValue.headers.get("content-type") ??
            set.headers["content-type"] ??
            set.headers["Content-Type"])
          : (set.headers["content-type"] ?? set.headers["Content-Type"]);
      if (typeof contentType !== "string" || !contentType.startsWith("text/html")) {
        return;
      }
      set.headers[header] = policy(
        usedNonces.has(request) ? requestNonces.get(request) : undefined
      );
    });
}
