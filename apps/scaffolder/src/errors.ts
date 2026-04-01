export class ScaffolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScaffolderError";
  }
}
