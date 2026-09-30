import type { SearchParamsInput } from "../../shared/search-params.ts";
import type { OptimisticCache } from "../sync.ts";
import { buildHref } from "./link-utils.ts";

interface Transformation {
  href: string;
  transform: (data: object) => object;
}
interface Operation {
  onRemove?: () => void;
  pending: boolean;
  transforms: Transformation[];
}
interface Snapshot {
  href: string;
  loaded: boolean;
}

export const SYNC_REQUEST = Symbol("furin.sync.request");

export interface OptimisticRuntime {
  basePath: string;
  begin: (
    optimistic: ((cache: OptimisticCache) => void) | undefined,
    onRemove?: () => void
  ) => Operation;
  commit: (href: string) => void;
  finish: (
    operation: Operation,
    outcome: "success" | "error" | "ambiguous",
    response: Response | undefined
  ) => void;
  has: (href: string) => boolean;
  project: <Data extends object>(data: Data, href: string) => Data;
  publishable: (href: string, revision: number) => boolean;
  revision: (href?: string) => number;
  subscribe: (listener: () => void) => () => void;
  wait: (href: string, signal: AbortSignal | undefined) => Promise<void>;
}

interface RuntimeOptions {
  basePath: string;
  onResponse: (response: Response | undefined, optimistic: boolean) => void;
  snapshot: () => Snapshot;
}

function identity(href: string): string {
  const url = new URL(href, "http://furin.local");
  url.searchParams.sort();
  return url.pathname + url.search;
}

const runtimes = new Set<OptimisticRuntime>();

export function registerOptimisticRuntime(runtime: OptimisticRuntime): () => void {
  runtimes.add(runtime);
  return () => {
    runtimes.delete(runtime);
  };
}

export function findOptimisticRuntime(domain: string): OptimisticRuntime | undefined {
  if (
    typeof window === "undefined" ||
    new URL(domain, window.location.origin).origin !== window.location.origin
  ) {
    return;
  }
  const path = window.location.pathname;
  const matches = [...runtimes]
    .filter(
      ({ basePath }) => basePath === "" || path === basePath || path.startsWith(`${basePath}/`)
    )
    .sort((a, b) => b.basePath.length - a.basePath.length);
  // Overlapping providers must not receive one another's projections.
  return matches[0]?.basePath === matches[1]?.basePath ? undefined : matches[0];
}

export function createOptimisticRuntime(options: RuntimeOptions): OptimisticRuntime {
  const operations = new Set<Operation>();
  const listeners = new Set<() => void>();
  const revisions = new Map<string, number>();
  let version = 0;
  const notify = (operation: Operation) => {
    version += 1;
    for (const { href } of operation.transforms) {
      revisions.set(href, (revisions.get(href) ?? 0) + 1);
    }
    for (const listener of listeners) {
      listener();
    }
  };
  const pending = (href: string) =>
    [...operations].some(
      (operation) =>
        operation.pending &&
        operation.transforms.some((transform) => transform.href === identity(href))
    );

  return {
    basePath: options.basePath,
    begin(optimistic, onRemove) {
      const operation: Operation = { onRemove, pending: true, transforms: [] };
      const cache = {
        update(
          target: string | { path: string; search?: SearchParamsInput },
          transform: (data: object) => object
        ) {
          const href = identity(
            typeof target === "string" ? target : buildHref(target.path, target.search, undefined)
          );
          const snapshot = options.snapshot();
          if (snapshot.loaded && href === identity(snapshot.href)) {
            operation.transforms.push({ href, transform });
          }
        },
      } as unknown as OptimisticCache;
      optimistic?.(cache);
      if (operation.transforms.length > 0) {
        operations.add(operation);
        notify(operation);
      }
      return operation;
    },
    commit(href) {
      for (const operation of operations) {
        if (!operation.pending) {
          operation.transforms = operation.transforms.filter(
            (transform) => transform.href !== identity(href)
          );
          if (operation.transforms.length === 0) {
            operations.delete(operation);
            operation.onRemove?.();
          }
        }
      }
      // Router publishes the new base and removal together; no intermediate notification.
    },
    finish(operation, outcome, response) {
      operation.pending = false;
      if (outcome === "error") {
        operations.delete(operation);
      }
      if (outcome === "error" || operation.transforms.length === 0) {
        operation.onRemove?.();
      }
      if (operation.transforms.length > 0) {
        notify(operation);
      }
      options.onResponse(response, outcome !== "error" && operation.transforms.length > 0);
    },
    has: (href) =>
      [...operations].some((operation) =>
        operation.transforms.some((transform) => transform.href === identity(href))
      ),
    project(data, href) {
      let projected: object = data;
      for (const operation of operations) {
        for (const transformation of operation.transforms) {
          if (transformation.href === identity(href)) {
            projected = { ...projected, ...transformation.transform(projected) };
          }
        }
      }
      return projected as typeof data;
    },
    publishable: (href, revision) =>
      !pending(href) && (revisions.get(identity(href)) ?? 0) === revision,
    revision: (href) => (href === undefined ? version : (revisions.get(identity(href)) ?? 0)),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    wait(href, signal) {
      if (signal?.aborted) {
        return Promise.reject(signal.reason);
      }
      if (!pending(href)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          listeners.delete(check);
          signal?.removeEventListener("abort", abort);
        };
        const abort = () => {
          cleanup();
          reject(signal?.reason);
        };
        const check = () => {
          if (!pending(href)) {
            cleanup();
            resolve();
          }
        };
        listeners.add(check);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
}
