import type { FC } from "react";

const NOT_FOUND_BRAND = "FURIN_NOT_FOUND" as const;

export interface NotFoundOptions {
  data?: unknown;
  message?: string;
}

export interface NotFoundProps {
  error: {
    message?: string;
    data?: unknown;
  };
}

export type NotFoundComponent = FC<NotFoundProps>;

export class FurinNotFoundError extends Error {
  readonly __furinBrand = NOT_FOUND_BRAND;
  readonly data: unknown;

  constructor(options?: NotFoundOptions) {
    super(options?.message ?? "");
    this.data = options?.data;
  }
}

export function notFound(options?: NotFoundOptions): never {
  throw new FurinNotFoundError(options);
}

export function isNotFoundError(err: unknown): err is FurinNotFoundError {
  return (
    err instanceof FurinNotFoundError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { __furinBrand?: unknown }).__furinBrand === NOT_FOUND_BRAND)
  );
}
