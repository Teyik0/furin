import type { DevtoolsServerEvent } from "../devtools/protocol.ts";
import type { DevDiagnosticEvent } from "./dev-diagnostics.ts";

export const BROWSER_EVENT_PROTOCOL_VERSION = 1 as const;

export type BrowserEventEnvelope =
  | {
      channel: "diagnostic";
      data: DevDiagnosticEvent;
      version: typeof BROWSER_EVENT_PROTOCOL_VERSION;
    }
  | {
      channel: "devtools";
      data: DevtoolsServerEvent;
      version: typeof BROWSER_EVENT_PROTOCOL_VERSION;
    }
  | {
      channel: "sync";
      data: { cursor: string };
      version: typeof BROWSER_EVENT_PROTOCOL_VERSION;
    };

export type BrowserEventChannel = BrowserEventEnvelope["channel"];

export type BrowserEventFor<TChannel extends BrowserEventChannel> = Extract<
  BrowserEventEnvelope,
  { channel: TChannel }
>;
