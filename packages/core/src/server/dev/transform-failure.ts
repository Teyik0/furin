export class DevTransformFailure extends Error {
  readonly error: unknown;

  constructor(error: unknown, options: ErrorOptions) {
    super("Development source transform failed", options);
    this.error = error;
  }
}
