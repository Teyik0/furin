import type { FC } from "react";

export interface ErrorProps {
  error: {
    message: string;
  };
}

export type ErrorComponent = FC<ErrorProps>;
