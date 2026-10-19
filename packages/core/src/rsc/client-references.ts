const REGISTRY = Symbol.for("furin.rsc.client-references");
const CLIENT_REFERENCE = Symbol.for("react.client.reference");
const COMPONENT_OBJECTS: ReadonlySet<unknown> = new Set([
  Symbol.for("react.forward_ref"),
  Symbol.for("react.lazy"),
  Symbol.for("react.memo"),
]);

interface ReferenceMetadata {
  async: true;
  chunks: [];
  id: string;
  name: string;
}

/** The fields React's tagged client references expose to the Flight renderer. */
interface ClientReferenceView {
  $$async: false;
  $$id: string;
  $$typeof: typeof CLIENT_REFERENCE;
}

interface ReferenceRegistry {
  loaders: Map<string, () => Promise<object>>;
  manifest: { [reference: string]: ReferenceMetadata };
  modules: Map<string, object | Promise<object>>;
  pending: Map<object, string>;
  references: WeakMap<object, ClientReferenceView>;
}

const host = globalThis as typeof globalThis & { [REGISTRY]?: ReferenceRegistry };
const registry: ReferenceRegistry = (host[REGISTRY] ??= {
  loaders: new Map(),
  manifest: {},
  modules: new Map(),
  pending: new Map(),
  references: new WeakMap(),
});

export const clientReferenceManifest = registry.manifest;

export function registerClientLoader(id: string, load: () => Promise<object>): void {
  registry.loaders.set(id, load);
}

/**
 * Flight reads `$$typeof`, `$$id` and `$$async` through this view (see
 * flight-loader.ts). Client exports become references without mutating the
 * component objects SSR and the browser share.
 */
export function clientReference(value: unknown): unknown {
  return registry.references.get(value as object) ?? value;
}

function addClientReference(value: object, id: string, name: string): void {
  if (registry.references.has(value)) {
    return;
  }
  const reference = `${id}#${name}`;
  registry.references.set(value, {
    $$async: false,
    $$id: reference,
    $$typeof: CLIENT_REFERENCE,
  });
  registry.manifest[reference] = { async: true, chunks: [], id, name };
}

function markClientExport(value: unknown, id: string, name: string): void {
  if (
    (typeof value === "function" && !("$$typeof" in value)) ||
    (typeof value === "object" &&
      value !== null &&
      "$$typeof" in value &&
      COMPONENT_OBJECTS.has(value.$$typeof))
  ) {
    addClientReference(value, id, name);
  }
}

export function createClientReference(id: string, name: string): () => never {
  const reference = () => {
    throw new Error(`[furin/rsc] Cannot call client export ${id}#${name} in the RSC graph`);
  };
  addClientReference(reference, id, name);
  return reference;
}

function markClientModule(exports: object, id: string): void {
  for (const name of Object.keys(exports)) {
    let value: unknown;
    try {
      value = exports[name as keyof typeof exports];
    } catch {
      // Uninitialized binding of a module cycle: markClientModules retries it.
      continue;
    }
    markClientExport(value, id, name);
  }
}

export function registerClientModule(id: string, exports: object): object {
  registry.modules.set(id, exports);
  // Flight can reach a module imported during a render before its next call
  // to markClientModules, so mark the bindings that already exist.
  markClientModule(exports, id);
  // A module cycle can register a namespace before all its bindings exist.
  registry.pending.set(exports, id);
  return exports;
}

/** Marks client exports that were not initialized yet when registered. */
export function markClientModules(): void {
  for (const [exports, id] of registry.pending) {
    markClientModule(exports, id);
  }
  registry.pending.clear();
}

export function requireClientModule(id: string): object | Promise<object> {
  let module = registry.modules.get(id);
  if (module === undefined) {
    const load = registry.loaders.get(id);
    if (load !== undefined) {
      const pending = load();
      module = pending;
      registry.modules.set(id, pending);
      pending.catch(() => {
        if (registry.modules.get(id) === pending) {
          registry.modules.delete(id);
        }
      });
    }
  }
  if (module === undefined) {
    throw new Error(`[furin/rsc] Unknown client reference module: ${id}`);
  }
  return module;
}
