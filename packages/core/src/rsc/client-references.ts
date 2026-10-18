import { createElement, type ElementType, type ReactNode } from "react";

const REGISTRY = Symbol.for("furin.rsc.client-references");
const FORWARD_REF = Symbol.for("react.forward_ref");
const LAZY = Symbol.for("react.lazy");
const MEMO = Symbol.for("react.memo");

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
  pending: Map<object, string>;
}

interface ReferenceProps {
  ref?: unknown;
}

type ComponentObject =
  | { $$typeof: typeof FORWARD_REF; render: (props: object, ref: unknown) => ReactNode }
  | { $$typeof: typeof LAZY; _init: (payload: unknown) => ElementType<object> }
  | { $$typeof: typeof MEMO; type: ElementType<object> };

const host = globalThis as typeof globalThis & { [REGISTRY]?: ReferenceRegistry };
const registry: ReferenceRegistry = (host[REGISTRY] ??= {
  loaders: new Map(),
  manifest: {},
  modules: new Map(),
  pending: new Map(),
});

export const clientReferenceManifest = registry.manifest;

export function registerClientLoader(id: string, load: () => Promise<object>): void {
  registry.loaders.set(id, load);
}

function markClientReference<TValue extends object>(
  value: TValue,
  id: string,
  name: string
): TValue {
  const reference = `${id}#${name}`;
  Object.defineProperties(value, {
    $$async: { value: false },
    $$id: { value: reference },
    $$typeof: { value: Symbol.for("react.client.reference") },
  });
  registry.manifest[reference] = { async: true, chunks: [], id, name };
  return value;
}

function markClientExport(value: unknown, id: string, name: string): void {
  if (typeof value === "function") {
    if (!("$$typeof" in value)) {
      markClientReference(value, id, name);
    }
    return;
  }
  if (typeof value !== "object" || value === null || "$$id" in value) {
    return;
  }
  // React renderers dispatch component objects on $$typeof. Keep it, and
  // instead mark a function Flight reaches while unwrapping the object. It
  // is dedicated to this export: the wrapped component can be shared.
  const component = value as ComponentObject;
  switch (component.$$typeof) {
    case MEMO: {
      Object.defineProperty(component, "$$id", { value: `${id}#${name}` });
      const { type } = component;
      component.type = markClientReference((props: object) => createElement(type, props), id, name);
      return;
    }
    case FORWARD_REF: {
      Object.defineProperty(component, "$$id", { value: `${id}#${name}` });
      const { render } = component;
      const Reference = markClientReference(
        ({ ref, ...props }: ReferenceProps) => render(props, ref),
        id,
        name
      );
      component.render = (props, ref) =>
        createElement(Reference, ref === null || ref === undefined ? props : { ...props, ref });
      return;
    }
    case LAZY: {
      Object.defineProperty(component, "$$id", { value: `${id}#${name}` });
      const init = component._init;
      let Reference: ((props: object) => ReactNode) | undefined;
      component._init = (payload) => {
        const resolved = init(payload);
        Reference ??= markClientReference(
          (props: object) => createElement(resolved, props),
          id,
          name
        );
        return Reference;
      };
      return;
    }
    default:
  }
}

export function createClientReference(id: string, name: string): () => never {
  const reference = () => {
    throw new Error(`[furin/rsc] Cannot call client export ${id}#${name} in the RSC graph`);
  };
  markClientReference(reference, id, name);
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
