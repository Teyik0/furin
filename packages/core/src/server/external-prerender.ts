const externalPrerenderRequests = new WeakSet<Request>();

export function isExternalPrerenderRequest(request: Request): boolean {
  return externalPrerenderRequests.has(request);
}

export function markExternalPrerenderRequest(request: Request): Request {
  externalPrerenderRequests.add(request);
  return request;
}
