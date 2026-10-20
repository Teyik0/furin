// Bun's build plugin already binds the Flight loader in compiled graphs.
export function installClientCodec(): void {
  // The build plugin installs the adapter before emitting this module.
}
