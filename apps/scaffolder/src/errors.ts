export class ScaffolderError extends Error {
  override readonly name = "ScaffolderError";
}

export class CancelledError extends Error {
  override readonly name = "CancelledError";
  constructor() {
    super("Scaffolding cancelled by user.");
  }
}
