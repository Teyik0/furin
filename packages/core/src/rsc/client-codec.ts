type ClientCodecLoader = () => Promise<typeof import("react-server-dom-webpack/client.edge")>;

let codecLoader: ClientCodecLoader | undefined;

export function setClientCodecLoader(load: ClientCodecLoader): void {
  codecLoader = load;
}

export async function decodeFlight(stream: ReadableStream<Uint8Array>): Promise<unknown> {
  const { createFromReadableStream } = await (codecLoader === undefined
    ? import("react-server-dom-webpack/client.edge")
    : codecLoader());
  return createFromReadableStream(stream, {
    serverConsumerManifest: {
      moduleLoading: null,
      moduleMap: null,
      serverModuleMap: {},
    },
  });
}
