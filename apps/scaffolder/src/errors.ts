export class ScaffolderError extends Error {
  override readonly name = "ScaffolderError";
  constructor(message: string) {
    super(message);
  }
}

export class CancelledError extends Error {
  override readonly name = "CancelledError";
  constructor() {
    super("Scaffolding cancelled by user.");
  }
}
