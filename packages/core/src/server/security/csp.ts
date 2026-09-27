import { Elysia } from "elysia";

export interface FurinCspOptions {
  policy: (nonce: string | undefined) => string;
  reportOnly?: boolean;
}

const requestNonces = new WeakMap<Request, string>();
const usedNonces = new WeakSet<Request>();
const HTML_CONTENT_TYPE = /^text\/html(?:\s*;|\s*$)/i;

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
  return new Elysia().wrap((fetch) => async (request, ...rest) => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    requestNonces.set(request, btoa(String.fromCharCode(...bytes)));
    const response = await fetch(request, ...rest);
    // Bun returns undefined after a successful WebSocket upgrade.
    if (!(response instanceof Response)) {
      return response;
    }
    const contentType = response.headers.get("content-type");
    if (contentType === null || !HTML_CONTENT_TYPE.test(contentType)) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set(header, policy(usedNonces.has(request) ? requestNonces.get(request) : undefined));
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  });
}
