import { type AnyElysia, Elysia } from "elysia";
import type { ResolvedRoutesSource } from "../router/types.ts";

interface CacheAccessInput {
  cache: "isr-loader" | "ssg-loader";
  operationId: string | null;
  outcome: "hit" | "miss" | "stale";
  path: string;
  requestId: string;
}

interface CacheInvalidatedInput {
  deleted: boolean;
  operationId: string | null;
  purgedPaths: number;
  reason: "path" | "source" | "tag";
  requestId: string | null;
  target: string;
}

interface LoaderFinishedInput {
  durationMs: number;
  fieldNames: string[];
  loader: string;
  operationId: string | null;
  path: string;
  requestId: string;
  status: "fulfilled" | "rejected";
}

interface PayloadSerializedInput {
  bytes: number;
  kind: "route-data" | "rsc";
  operationId: string | null;
  path: string;
  requestId: string;
}

export function emitCacheAccess(_event: CacheAccessInput): void {
  // Production instrumentation is intentionally empty.
}

export function emitCacheInvalidated(_event: CacheInvalidatedInput): void {
  // Production instrumentation is intentionally empty.
}

export function emitLoaderFinished(_event: LoaderFinishedInput): void {
  // Production instrumentation is intentionally empty.
}

export function emitPayloadSerialized(_event: PayloadSerializedInput): void {
  // Production instrumentation is intentionally empty.
}

export function currentInstrumentationRequest(): void {
  // Production instrumentation has no request-local state.
}

export function runWithRequestInstrumentation<T>(_request: Request, fn: () => T): T {
  return fn();
}

export function shouldInstrumentRequest(_pathname: string, _prefix: string): boolean {
  return false;
}

export function instrumentationLoggerExclusions(_prefix: string): string[] {
  return [];
}

export function createInstrumentationPlugin(
  _routes: ResolvedRoutesSource,
  _syncStreamPath: string | undefined
): AnyElysia {
  return new Elysia({ name: "furin-production-instrumentation" });
}

export function injectInstrumentationClient(html: string, _prefix: string): string {
  return html;
}
