export interface DevtoolsClientBuild {
  changedModules: string[];
  cycleId: string;
  detectedAt: number;
  durationMs: number;
  rebuiltModules: string[];
  startedAt: number;
  status: "fulfilled" | "rejected";
}

export interface DevtoolsPendingCycle {
  cycleId: string;
  detectedAt: number;
  sourcePath: string;
}

interface DevtoolsBuildObserverState {
  listeners: Set<(build: DevtoolsClientBuild) => void>;
  sequence: number;
}

const BUILD_OBSERVER_STATE = Symbol.for("@teyik0/furin/devtools-build-observer");

function observerState(): DevtoolsBuildObserverState {
  const existing = Reflect.get(globalThis, BUILD_OBSERVER_STATE);
  if (existing) {
    return existing as DevtoolsBuildObserverState;
  }
  const state: DevtoolsBuildObserverState = {
    listeners: new Set(),
    sequence: 0,
  };
  Reflect.set(globalThis, BUILD_OBSERVER_STATE, state);
  return state;
}

export function nextDevtoolsBuildId(): string {
  const state = observerState();
  state.sequence += 1;
  return `${Date.now().toString(36)}-${state.sequence.toString(36)}`;
}

export function publishDevtoolsClientBuild(build: DevtoolsClientBuild): void {
  for (const listener of observerState().listeners) {
    try {
      listener(build);
    } catch {
      // Diagnostics must never interrupt Bun's client build.
    }
  }
}

export function takeDevtoolsPendingCycle(
  cycles: DevtoolsPendingCycle[],
  changedModules: string[]
): DevtoolsPendingCycle | undefined {
  const changedModuleSet = new Set(changedModules);
  let matchedCycle: DevtoolsPendingCycle | undefined;
  for (let index = cycles.length - 1; index >= 0; index -= 1) {
    const cycle = cycles[index];
    if (cycle && changedModuleSet.has(cycle.sourcePath)) {
      matchedCycle ??= cycle;
      cycles.splice(index, 1);
    }
  }
  return matchedCycle;
}

export function subscribeDevtoolsClientBuilds(
  listener: (build: DevtoolsClientBuild) => void
): () => void {
  const { listeners } = observerState();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
