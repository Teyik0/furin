export interface HelloPayload {
  message: string;
  source: string;
}

export function getHelloPayload(): HelloPayload {
  return {
    message: "Hello from Elysia",
    source: "api:/api/hello",
  };
}
