import { createFromReadableStream } from "react-server-dom-webpack/client.edge";

// Bun's build plugin already binds the Flight loader in compiled graphs.
export function installClientCodec(): void {
  // The build plugin installs the adapter before emitting this module.
}

// The browser can use a static import; only native SSR needs a runtime plugin.
export function decodeFlight(stream: ReadableStream<Uint8Array>): Promise<unknown> {
  return createFromReadableStream(stream, {
    serverConsumerManifest: {
      moduleLoading: null,
      moduleMap: null,
      serverModuleMap: {},
    },
  });
}
