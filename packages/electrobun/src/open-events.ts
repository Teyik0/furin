import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenEvent } from "./capabilities";

/** Ignore runtime/SDK flags; normalize only explicitly registered native inputs. */
export function nativeLaunchEvents(
  args: string[],
  schemes: string[],
  extensions: string[],
  cwd: string
): OpenEvent[] {
  const events: OpenEvent[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) {
      continue;
    }
    if (URL.canParse(arg)) {
      const url = new URL(arg);
      if (schemes.includes(url.protocol.slice(0, -1).toLowerCase())) {
        events.push({ type: "url", url: url.href });
        continue;
      }
      if (url.protocol === "file:") {
        const path = fileURLToPath(url);
        if (extensions.includes(extname(path).slice(1).toLowerCase())) {
          events.push({ type: "file", path });
        }
        continue;
      }
    }
    if (extensions.includes(extname(arg).slice(1).toLowerCase())) {
      events.push({ type: "file", path: resolve(cwd, arg) });
    }
  }
  return events;
}
