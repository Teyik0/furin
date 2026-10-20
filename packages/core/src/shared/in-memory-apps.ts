import type { AnyElysia } from "elysia";

// Shared through globalThis: the AOT build installs the collector before
// evaluating the application, whichever copy of Furin it loads.
const IN_MEMORY_APPS = Symbol.for("@teyik0/furin/in-memory-apps");

interface InMemoryAppGlobal {
  [IN_MEMORY_APPS]?: Set<AnyElysia>;
}

/** Starts recording the Elysia instances in-memory Eden clients handle. */
export function collectInMemoryApps(): void {
  (globalThis as InMemoryAppGlobal)[IN_MEMORY_APPS] = new Set();
}

/** Records an Elysia instance an Eden client calls through `.handle()`, while a build collects them. */
export function recordInMemoryApp(app: AnyElysia): void {
  (globalThis as InMemoryAppGlobal)[IN_MEMORY_APPS]?.add(app);
}

/** The recorded instances, in recording order; empty outside a build. */
export function inMemoryApps(): AnyElysia[] {
  return [...((globalThis as InMemoryAppGlobal)[IN_MEMORY_APPS] ?? [])];
}
