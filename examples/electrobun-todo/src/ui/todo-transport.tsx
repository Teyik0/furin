import { useRouter } from "@teyik0/furin/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTodoClient } from "../todo-client";
import type { TodoSyncStatus } from "../todo-types";

const eventsKey = Symbol.for("furin.browser-events.runtime");
interface BrowserSyncRuntime {
  subscribeStatus: (listener: (status: TodoSyncStatus) => void) => () => boolean;
}

export function useTodoTransport() {
  const router = useRouter();
  const [status, setStatus] = useState<TodoSyncStatus>("connecting");
  const [error, setError] = useState<string>();
  const active = useRef<boolean>(false);
  const connected = useRef<boolean>(false);
  const version = useRef(0);
  const retry = useRef<boolean>(false);
  const client = useMemo(
    () =>
      createTodoClient(typeof window === "undefined" ? "http://localhost" : window.location.origin),
    []
  );
  const refresh = useCallback(async () => {
    version.current += 1;
    const pending = version.current;
    retry.current = false;
    setStatus("connecting");
    try {
      await router.refresh();
      if (active.current && pending === version.current) {
        setError(undefined);
        setStatus(connected.current ? "connected" : "reconnecting");
      }
    } catch (failure) {
      if (active.current && pending === version.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setStatus("reconnecting");
        retry.current = true;
      }
      throw failure;
    }
  }, [router.refresh]);
  useEffect(() => {
    active.current = true;
    const events = (globalThis as typeof globalThis & { [eventsKey]?: BrowserSyncRuntime })[
      eventsKey
    ];
    const unsubscribe = events?.subscribeStatus((next) => {
      connected.current = next === "connected";
      version.current += 1;
      if (connected.current) {
        // Transport-open is not snapshot-ready: close the SSR/subscription gap.
        refresh().catch(() => undefined);
      } else {
        setStatus(next);
      }
    });
    const timer = setInterval(() => {
      if (retry.current && connected.current) {
        refresh().catch(() => undefined);
      }
    }, 1000);
    return () => {
      active.current = false;
      version.current += 1;
      clearInterval(timer);
      unsubscribe?.();
    };
  }, [refresh]);
  return { api: client.api, refresh, status, error };
}
