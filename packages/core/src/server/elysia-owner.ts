import { type AnyElysia, Elysia } from "elysia";

type RequestScopeWrapper = Parameters<AnyElysia["wrap"]>[0];

interface OwnerBindings {
  handles: WeakMap<AnyElysia, AnyElysia["handle"]>;
  owners: WeakMap<readonly RequestScopeWrapper[], AnyElysia>;
  wrappers: WeakSet<RequestScopeWrapper>;
}

const OWNER_BINDINGS = Symbol.for("@teyik0/furin/elysia-owner-bindings");

function bindOwner(app: AnyElysia, bindings: OwnerBindings): boolean {
  const extension = Reflect.get(app, "~ext") as { hoc?: RequestScopeWrapper[] } | undefined;
  const wrappers = extension?.hoc;
  if (!wrappers?.some((wrapper) => bindings.wrappers.has(wrapper))) {
    return false;
  }
  bindings.owners.set(wrappers, app);
  return true;
}

function ownedHandle(
  app: AnyElysia,
  original: AnyElysia["handle"],
  bindings: OwnerBindings
): AnyElysia["handle"] {
  let handle = bindings.handles.get(app);
  if (!handle) {
    handle = (...args) => {
      const run = () => {
        bindOwner(app, bindings);
        return original(...args);
      };
      // Unlike fetch, Elysia beta's handle skips pending async plugins.
      return Reflect.get(app, "ready") ? app.modules.then(run, run) : run();
    };
    bindings.handles.set(app, handle);
  }
  return handle;
}

/**
 * Elysia invokes HOC factories on their array without passing the owning app.
 * Its fetch/handle getters are the final composition boundary, including
 * detached fetch handlers and WinterCG handle(). Delegate them unchanged and
 * associate only arrays containing a Furin wrapper. Shared bindings keep this
 * adapter idempotent across hot reloads and multiple Furin module copies.
 */
function ownerBindings(): OwnerBindings {
  const existing = Reflect.get(Elysia.prototype, OWNER_BINDINGS) as OwnerBindings | undefined;
  if (existing) {
    return existing;
  }
  const bindings: OwnerBindings = {
    handles: new WeakMap(),
    owners: new WeakMap(),
    wrappers: new WeakSet(),
  };
  for (const property of ["fetch", "handle"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(Elysia.prototype, property);
    if (!(descriptor?.get && descriptor.configurable)) {
      throw new Error(`[furin] Unsupported Elysia ${property} getter.`);
    }
    const getter = descriptor.get;
    Object.defineProperty(Elysia.prototype, property, {
      ...descriptor,
      get(this: AnyElysia) {
        const owned = bindOwner(this, bindings);
        const original = getter.call(this);
        return property === "handle" && owned ? ownedHandle(this, original, bindings) : original;
      },
    });
  }
  Object.defineProperty(Elysia.prototype, OWNER_BINDINGS, { value: bindings });
  return bindings;
}

export function registerRequestScopeWrapper(wrapper: RequestScopeWrapper): void {
  ownerBindings().wrappers.add(wrapper);
}

export function requestScopeOwner(wrappers: readonly RequestScopeWrapper[]): AnyElysia | undefined {
  return ownerBindings().owners.get(wrappers);
}
