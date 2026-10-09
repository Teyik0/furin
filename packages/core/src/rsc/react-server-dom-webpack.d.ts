declare module "react-server-dom-webpack/server.edge" {
  export function renderToReadableStream(
    model: unknown,
    clientManifest: object,
    options?: {
      onError?: (error: unknown) => string | undefined;
      signal?: AbortSignal;
    }
  ): ReadableStream<Uint8Array>;
}

declare module "react-server-dom-webpack/client.edge" {
  interface ServerConsumerManifest {
    moduleLoading: null;
    moduleMap: object | null;
    serverModuleMap: object;
  }

  export function createFromReadableStream(
    stream: ReadableStream<Uint8Array>,
    options: { serverConsumerManifest: ServerConsumerManifest }
  ): Promise<unknown>;
}
