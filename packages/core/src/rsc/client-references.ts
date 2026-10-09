const REGISTRY = Symbol.for("furin.rsc.client-references");

interface ReferenceMetadata {
  async: true;
  chunks: [];
  id: string;
  name: string;
}

interface ReferenceRegistry {
  loaders: Map<string, () => Promise<object>>;
  manifest: { [reference: string]: ReferenceMetadata };
  modules: Map<string, object | Promise<object>>;
}

const host = globalThis as typeof globalThis & { [REGISTRY]?: ReferenceRegistry };
const registry: ReferenceRegistry = (host[REGISTRY] ??= {
  loaders: new Map(),
  manifest: {},
  modules: new Map(),
});

export const clientReferenceManifest = registry.manifest;

export function registerClientLoader(id: string, load: () => Promise<object>): void {
  registry.loaders.set(id, load);
}

function markClientReference(value: object, id: string, name: string): void {
  const reference = `${id}#${name}`;
  Object.defineProperties(value, {
    $$async: { value: false },
    $$id: { value: reference },
    $$typeof: { value: Symbol.for("react.client.reference") },
  });
  registry.manifest[reference] = { async: true, chunks: [], id, name };
}

export function createClientReference(id: string, name: string): () => never {
  const reference = () => {
    throw new Error(`[furin/rsc] Cannot call client export ${id}#${name} in the RSC graph`);
  };
  markClientReference(reference, id, name);
  return reference;
}

export function registerClientModule(id: string, exports: object): object {
  registry.modules.set(id, exports);
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== "function" || "$$typeof" in value) {
      continue;
    }
    markClientReference(value, id, name);
  }
  return exports;
}

export function requireClientModule(id: string): object | Promise<object> {
  let module = registry.modules.get(id);
  if (module === undefined) {
    const load = registry.loaders.get(id);
    if (load !== undefined) {
      module = load();
      registry.modules.set(id, module);
    }
  }
  if (module === undefined) {
    throw new Error(`[furin/rsc] Unknown client reference module: ${id}`);
  }
  return module;
}
