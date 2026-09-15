export const EXTERNAL_PRERENDER_HEADER = "x-furin-external-prerender";

export function isExternalPrerenderRequest(request: Request): boolean {
  return request.headers.get(EXTERNAL_PRERENDER_HEADER) === "1";
}
