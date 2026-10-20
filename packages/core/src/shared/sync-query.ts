export interface QueryScope {
  readonly [key: string]: string | number | boolean | null | undefined;
}

/** A GET's URL identity: its route pattern (`/cards/:id`) and params; the query string is ignored. */
export interface QueryIdentity {
  id: string;
  scope: QueryScope;
}

export interface QueryReadIdentity extends QueryIdentity {
  session: string;
}

export function serializeQueryHeader(identity: QueryIdentity | readonly QueryIdentity[]): string {
  return JSON.stringify(identity).replace(
    /[^\u0020-\u007e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

export interface QuerySeed {
  bindings?: QueryBinding[];
  data: unknown;
  identity: QueryReadIdentity;
  local?: boolean;
  url: string;
}

export interface QueryBinding {
  source: string[];
  target: string[];
}

export function mergeQuerySeeds(target: QuerySeed[], incoming: readonly QuerySeed[]): void {
  for (const seed of incoming) {
    const index = target.findIndex((existing) => existing.url === seed.url);
    const previous = target[index];
    const bindings = [...(seed.bindings ?? [])];
    let { data } = seed;
    if (
      previous?.identity.session === seed.identity.session &&
      queryTag(previous.identity) === queryTag(seed.identity)
    ) {
      // A dependency-only copy must not erase a body another loader field exposed whole.
      if (data === undefined) {
        ({ data } = previous);
      }
      for (const binding of previous.bindings ?? []) {
        if (
          !bindings.some((next) => JSON.stringify(next.target) === JSON.stringify(binding.target))
        ) {
          bindings.push(binding);
        }
      }
    }
    const merged = { ...seed, data, bindings };
    if (index < 0) {
      target.push(merged);
    } else {
      target[index] = merged;
    }
  }
}

export function queryTagsFromData(data: object): string[] {
  return ((data as { __furinQueries?: QuerySeed[] }).__furinQueries ?? []).flatMap((seed) =>
    queryTags(seed.identity)
  );
}

const PREFIX = "__furin.query:";

export function queryTag(identity: QueryIdentity): string {
  for (const [key, value] of Object.entries(identity.scope)) {
    if (value === undefined) {
      throw new Error(`[furin] Query scope "${key}" is undefined for "${identity.id}".`);
    }
  }
  return (
    PREFIX +
    JSON.stringify([
      identity.id,
      Object.entries(identity.scope)
        // URL params are strings: a numeric param names the same URL.
        .map(([key, value]) => [key, typeof value === "number" ? String(value) : value] as const)
        .sort(([a], [b]) => {
          if (a === b) {
            return 0;
          }
          return a < b ? -1 : 1;
        }),
    ])
  );
}

/**
 * Every tag a read answers to: one per subset of its params, so an invalidation that omits a
 * param (`invalidate("/boards/:boardId")`) matches every value of it by exact tag.
 */
export function queryTags(identity: QueryIdentity): string[] {
  let scopes: QueryScope[] = [{}];
  for (const [key, value] of Object.entries(identity.scope)) {
    scopes = scopes.concat(scopes.map((scope) => ({ ...scope, [key]: value })));
  }
  return scopes.map((scope) => queryTag({ id: identity.id, scope }));
}

export function queryFromTag(tag: string): QueryIdentity | undefined {
  if (!tag.startsWith(PREFIX)) {
    return;
  }
  try {
    const value: unknown = JSON.parse(tag.slice(PREFIX.length));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      !Array.isArray(value[1]) ||
      value[1].some(
        (entry: unknown) =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          !(
            entry[1] === null ||
            typeof entry[1] === "string" ||
            typeof entry[1] === "number" ||
            typeof entry[1] === "boolean"
          )
      )
    ) {
      return;
    }
    return { id: value[0], scope: Object.fromEntries(value[1]) };
  } catch {
    // Ordinary cache tags may start with the reserved prefix without encoding a query.
  }
}

export function queryUrl(url: string, origin: string | undefined): string {
  const parsed = new URL(url, origin);
  parsed.searchParams.sort();
  return (parsed.origin === origin ? "" : parsed.origin) + parsed.pathname + parsed.search;
}
