import { useEffect, useLayoutEffect } from "react";
import { SCROLL_STORAGE_KEY } from "./history.ts";
import { decodeHashFragment } from "./link-utils.ts";
import type { NavigationController, NavigationSnapshot } from "./navigation-controller.ts";

/**
 * Connects the controller to browser history: keys the initial entry, renders
 * back/forward navigations, and applies each commit's scroll instruction
 * right after React renders it.
 */
export function useHistorySync(
  controller: NavigationController,
  navigation: NavigationSnapshot
): void {
  // Disable native scroll restoration and assign a key to the initial history entry.
  useEffect(() => {
    controller.adoptHistoryEntry();
  }, [controller]);

  // Render-synchronous scroll restoration, after every committed snapshot.
  useLayoutEffect(() => {
    const instruction = controller.takeScrollInstruction();
    if (!instruction) {
      return;
    }

    if (instruction.type === "restore") {
      try {
        const raw = sessionStorage.getItem(SCROLL_STORAGE_KEY);
        const positions: Record<string, number> = raw ? JSON.parse(raw) : {};
        const y = positions[instruction.key] ?? 0;
        window.scrollTo({ behavior: "instant", top: y });
      } catch {
        window.scrollTo({ behavior: "instant", top: 0 });
      }
      return;
    }

    const destUrl = new URL(instruction.href, window.location.origin);
    if (destUrl.hash) {
      const id = decodeHashFragment(destUrl.hash.slice(1));
      const element = document.getElementById(id);
      if (element) {
        element.scrollIntoView({ behavior: "instant", block: "start" });
      }
    } else {
      window.scrollTo({ behavior: "instant", top: 0 });
    }
  }, [controller, navigation]);

  // Handle browser back/forward
  useEffect(() => {
    window.addEventListener("popstate", controller.popState);
    return () => window.removeEventListener("popstate", controller.popState);
  }, [controller]);
}
