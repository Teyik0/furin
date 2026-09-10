function isLoopbackAddress(address: string): boolean {
  return (
    address === "::1" ||
    address === "0:0:0:0:0:0:0:1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

export function forbiddenDevelopmentRequest(
  request: Request,
  server: Bun.Server<unknown> | null
): Response | undefined {
  if (server !== null) {
    const peer = server.requestIP(request);
    if (peer === null || !isLoopbackAddress(peer.address)) {
      return new Response("Forbidden", { status: 403 });
    }
  }
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host") ?? requestUrl.host;
  let hostname: string;
  try {
    ({ hostname } = new URL(`http://${host}`));
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
    return new Response("Forbidden", { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== requestUrl.origin) {
    return new Response("Forbidden", { status: 403 });
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return new Response("Forbidden", { status: 403 });
  }
}
