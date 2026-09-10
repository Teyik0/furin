import { BROWSER_EVENT_PROTOCOL_VERSION } from "../../shared/browser-events.ts";
import type { BrowserEventSource } from "../browser-events/types.ts";
import { devtoolsEventsSnapshot, subscribeDevtoolsEventsAfter } from "../devtools/hub.ts";
import type { FurinInstance } from "../instance.ts";
import type { DevDiagnosticStore } from "./diagnostics.ts";

export function createDevelopmentBrowserEventSources(
  instance: FurinInstance,
  diagnostics: DevDiagnosticStore
): readonly BrowserEventSource[] {
  return [
    {
      subscribe(listener) {
        const subscription = diagnostics.subscribe(0, undefined, (event) =>
          listener({
            channel: "diagnostic",
            data: event,
            version: BROWSER_EVENT_PROTOCOL_VERSION,
          })
        );
        for (const event of subscription.replay) {
          listener({
            channel: "diagnostic",
            data: event,
            version: BROWSER_EVENT_PROTOCOL_VERSION,
          });
        }
        return { unsubscribe: subscription.unsubscribe };
      },
    },
    {
      subscribe(listener) {
        const cursor = devtoolsEventsSnapshot(instance).lastEventId;
        const subscription = subscribeDevtoolsEventsAfter(
          cursor,
          (event) =>
            listener({
              channel: "devtools",
              data: event,
              version: BROWSER_EVENT_PROTOCOL_VERSION,
            }),
          instance
        );
        for (const event of subscription.replay) {
          listener({
            channel: "devtools",
            data: event,
            version: BROWSER_EVENT_PROTOCOL_VERSION,
          });
        }
        return { unsubscribe: subscription.unsubscribe };
      },
    },
  ];
}
