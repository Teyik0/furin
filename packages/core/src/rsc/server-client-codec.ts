import { flightLoaderPlugin } from "./build/flight-loader.ts";
import { setClientCodecLoader } from "./client-codec.ts";

let installed = false;

export function installClientCodec(): void {
  setClientCodecLoader(() => {
    if (!installed) {
      installed = true;
      Bun.plugin(flightLoaderPlugin());
    }
    return import("react-server-dom-webpack/client.edge");
  });
}
