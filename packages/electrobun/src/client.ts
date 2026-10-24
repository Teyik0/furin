/// <reference lib="dom" />

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DESKTOP_RESPONSE,
  type DesktopRequest,
  getBrowserUrl,
  type OpenBrowserResult,
} from "./desktop-bridge";

export type { OpenBrowserResult } from "./desktop-bridge";

export type DesktopStatus = "initializing" | "web" | "desktop" | "unavailable";

export interface DesktopClient {
  browser: { open: (url: string) => Promise<OpenBrowserResult> };
  status: DesktopStatus;
}

type DesktopWindow = Window & { __electrobunSendToHost?: (message: DesktopRequest) => void };

function sendToHost(message: DesktopRequest, signal: AbortSignal): Promise<OpenBrowserResult> {
  const target = typeof window === "undefined" ? undefined : (window as DesktopWindow);
  if (!target?.__electrobunSendToHost || signal.aborted) {
    return Promise.resolve({ ok: false, reason: "unavailable" });
  }
  return new Promise((resolve) => {
    const finish = (result: OpenBrowserResult) => {
      clearTimeout(timer);
      target.removeEventListener(DESKTOP_RESPONSE, receive);
      signal.removeEventListener("abort", unavailable);
      resolve(result);
    };
    const unavailable = () => finish({ ok: false, reason: "unavailable" });
    const receive = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (
        typeof detail !== "object" ||
        detail === null ||
        !("id" in detail) ||
        detail.id !== message.id ||
        !("result" in detail)
      ) {
        return;
      }
      const { result } = detail;
      if (typeof result !== "object" || result === null || !("ok" in result)) {
        return;
      }
      if (result.ok === true) {
        finish({ ok: true });
      } else if (
        result.ok === false &&
        "reason" in result &&
        (result.reason === "unavailable" ||
          result.reason === "invalid-url" ||
          result.reason === "open-failed")
      ) {
        finish({ ok: false, reason: result.reason });
      }
    };
    const timer = setTimeout(unavailable, 5000);
    target.addEventListener(DESKTOP_RESPONSE, receive);
    signal.addEventListener("abort", unavailable, { once: true });
    try {
      target.__electrobunSendToHost?.(message);
    } catch {
      unavailable();
    }
  });
}

export function useDesktop(): DesktopClient {
  const [status, setStatus] = useState<DesktopStatus>("initializing");
  const lifetime = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    if ((window as DesktopWindow).__electrobunSendToHost) {
      sendToHost(
        { type: "furin:desktop", id: crypto.randomUUID(), command: "available" },
        controller.signal
      ).then((result) => {
        if (!controller.signal.aborted) {
          setStatus(result.ok ? "desktop" : "unavailable");
        }
      });
    } else {
      setStatus("web");
    }
    return () => {
      controller.abort();
      lifetime.current = undefined;
    };
  }, []);
  const open = useCallback(async (value: string): Promise<OpenBrowserResult> => {
    const controller = lifetime.current;
    if (
      !controller ||
      controller.signal.aborted ||
      typeof window === "undefined" ||
      !(window as DesktopWindow).__electrobunSendToHost
    ) {
      return { ok: false, reason: "unavailable" };
    }
    const url = getBrowserUrl(value, window.location.href);
    if (!url) {
      return { ok: false, reason: "invalid-url" };
    }
    const result = await sendToHost(
      { type: "furin:desktop", id: crypto.randomUUID(), command: "open-browser", url },
      controller.signal
    );
    if (!(controller.signal.aborted || result.ok) && result.reason === "unavailable") {
      setStatus((current) => (current === "desktop" ? "unavailable" : current));
    }
    return result;
  }, []);
  return { status, browser: { open } };
}
