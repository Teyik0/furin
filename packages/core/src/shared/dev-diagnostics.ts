export const DEV_DIAGNOSTIC_PROTOCOL_VERSION = 1;

export type DevDiagnosticPhase =
  | "client-render"
  | "hydrate"
  | "import"
  | "loader"
  | "render"
  | "transform";

export interface DevSourceLocation {
  column: number;
  file: string;
  line: number;
}

export interface DevStackFrame {
  functionName: string | undefined;
  generated: DevSourceLocation | undefined;
  internal: boolean;
  original: DevSourceLocation | undefined;
}

export interface DevDiagnostic {
  cause: string | undefined;
  frames: readonly DevStackFrame[];
  importChain: readonly string[];
  location: DevSourceLocation | undefined;
  message: string;
  phase: DevDiagnosticPhase;
  route: string;
  stack: string | undefined;
}

interface DevEventBase {
  id: number;
  revision: number;
  serverId: string;
  version: typeof DEV_DIAGNOSTIC_PROTOCOL_VERSION;
}

export type DevDiagnosticEvent =
  | (DevEventBase & { diagnostic: DevDiagnostic; type: "error" })
  | (DevEventBase & { type: "ready" });
