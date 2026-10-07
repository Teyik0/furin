import { type AnyElysia, Elysia } from "elysia";

type RequestScopeWrapper = Parameters<AnyElysia["wrap"]>[0];

interface OwnerBindings {
  owners: WeakMap<readonly RequestScopeWrapper[], AnyElysia>;
  prepare: WeakMap<RequestScopeWrapper, (app: AnyElysia) => Promise<void> | undefined>;
  preparedFetches: WeakMap<AnyElysia, AnyElysia["fetch"]>;
  preparedHandles: WeakMap<AnyElysia, AnyElysia["handle"]>;
  wrappers: WeakSet<RequestScopeWrapper>;
}

function prepareOwner(app: AnyElysia, bindings: OwnerBindings): Promise<void> | undefined {
  bindOwner(app, bindings);
  const extension = Reflect.get(app, "~ext") as { hoc?: RequestScopeWrapper[] } | undefined;
  for (const wrapper of extension?.hoc ?? []) {
    const pending = bindings.prepare.get(wrapper)?.(app);
    if (pending) {
      return pending.then(() => prepareOwner(app, bindings));
    }
  }
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
  let handle = bindings.preparedHandles.get(app);
  if (!handle) {
    handle = (...args) => {
      const run = () => {
        const pending = prepareOwner(app, bindings);
        return pending ? pending.then(() => original(...args)) : original(...args);
      };
      // Unlike fetch, Elysia beta's handle skips pending async plugins.
      return app.modules.then(run);
    };
    bindings.preparedHandles.set(app, handle);
  }
  return handle;
}

function ownedFetch(
  app: AnyElysia,
  original: () => AnyElysia["fetch"],
  bindings: OwnerBindings
): AnyElysia["fetch"] {
  const failed = Reflect.get(app, "_error") !== undefined;
  const pending = Reflect.get(app, "ready") || failed ? undefined : prepareOwner(app, bindings);
  if (!(pending || failed)) {
    original();
  }
  let fetch = bindings.preparedFetches.get(app);
  if (!fetch) {
    fetch = (request, ...rest) => {
      const run = (): ReturnType<AnyElysia["fetch"]> => {
        if (Reflect.get(app, "ready") || Reflect.get(app, "_error") !== undefined) {
          return app.modules.then(run);
        }
        const preparing = prepareOwner(app, bindings);
        return preparing ? preparing.then(run) : original()(request, ...rest);
      };
      return run();
    };
    bindings.preparedFetches.set(app, fetch);
  }
  return fetch;
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
  if (existing && Reflect.has(existing, "preparedHandles")) {
    return existing;
  }
  const bindings: OwnerBindings = existing ?? {
    preparedFetches: new WeakMap(),
    preparedHandles: new WeakMap(),
    owners: new WeakMap(),
    prepare: new WeakMap(),
    wrappers: new WeakSet(),
  };
  if (existing) {
    Object.assign(existing, {
      preparedFetches: new WeakMap(),
      preparedHandles: new WeakMap(),
      prepare: new WeakMap(),
    });
  }
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
        if (property === "fetch" && owned) {
          return ownedFetch(this, () => getter.call(this), bindings);
        }
        const original = getter.call(this);
        return property === "handle" && owned ? ownedHandle(this, original, bindings) : original;
      },
    });
  }
  if (!existing) {
    Object.defineProperty(Elysia.prototype, OWNER_BINDINGS, { value: bindings });
  }
  return bindings;
}

export function registerRequestScopeWrapper(
  wrapper: RequestScopeWrapper,
  prepare: (app: AnyElysia) => Promise<void> | undefined
): void {
  const bindings = ownerBindings();
  bindings.wrappers.add(wrapper);
  bindings.prepare.set(wrapper, prepare);
}

export function requestScopeOwner(wrappers: readonly RequestScopeWrapper[]): AnyElysia | undefined {
  return ownerBindings().owners.get(wrappers);
}

interface HookChain {
  callback?: HookChain;
  combine?: HookChain;
  inner?: HookChain;
  over?: HookChain;
  parent?: HookChain;
}

type NativeRoute = [
  string,
  string,
  unknown,
  AnyElysia,
  unknown,
  HookChain | undefined,
  HookChain | undefined,
  AnyElysia?,
];

function replaceChain(
  chain: HookChain | undefined,
  source: HookChain | undefined,
  replacement: HookChain | undefined
): HookChain | undefined {
  if (!(chain && source)) {
    return chain;
  }
  if (chain === source) {
    return replacement;
  }
  let result = chain;
  for (const key of ["parent", "combine", "over", "callback", "inner"] as const) {
    const next = replaceChain(chain[key], source, replacement);
    if (next !== chain[key]) {
      if (result === chain) {
        result = { ...chain };
      }
      result[key] = next;
    }
  }
  return result;
}

/** Replace only the Furin subtree; container/parent guards remain outside it. */
export function replaceFurinMountRoutes(
  owner: AnyElysia,
  source: AnyElysia,
  replacement: AnyElysia,
  parentPrefix: string
): void {
  const sourceRoutes = Reflect.get(source, "~routes") as NativeRoute[];
  const nextRoutes = Reflect.get(replacement, "~routes") as NativeRoute[];
  Reflect.get(owner, "~routes");
  const routes = Reflect.get(owner, "declaredRoutes") as NativeRoute[];
  for (const [index, route] of routes.entries()) {
    const original = sourceRoutes.find(
      (candidate) =>
        candidate[0] === route[0] &&
        candidate[2] === route[2] &&
        `${parentPrefix}${candidate[1]}` === route[1]
    );
    if (!original) {
      continue;
    }
    const next = nextRoutes.find(
      (candidate) => candidate[0] === original[0] && candidate[1] === original[1]
    );
    if (!next) {
      throw new Error(`[furin] Runtime route changed while composing ${route[1]}.`);
    }
    routes[index] = [
      route[0],
      route[1],
      next[2],
      next[3],
      next[4],
      next[5],
      replaceChain(route[6], original[6], next[6]),
      route[7] === original[7] ? next[7] : route[7],
    ];
  }
  Reflect.set(owner, "cachedRoutes", undefined);
}
