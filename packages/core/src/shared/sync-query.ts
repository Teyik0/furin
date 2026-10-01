export interface QueryScope {
  readonly [key: string]: string | number | boolean | null | undefined;
}

export interface QueryIdentity {
  id: string;
  scope: QueryScope;
}

type RegisteredScope<Id extends keyof SyncQueryMap> = keyof SyncQueryMap[Id] extends never
  ? { readonly [key: string]: never }
  : {
      readonly [Key in keyof SyncQueryMap[Id]]: Extract<SyncQueryMap[Id][Key], QueryScope[string]>;
    };

export type SyncQueryIdentity = keyof SyncQueryMap extends never
  ? QueryIdentity
  : {
      [Id in keyof SyncQueryMap & string]: { id: Id; scope: RegisteredScope<Id> };
    }[keyof SyncQueryMap & string];

export interface QueryReadIdentity extends QueryIdentity {
  session: string;
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
    if (
      previous?.identity.session === seed.identity.session &&
      queryTag(previous.identity) === queryTag(seed.identity)
    ) {
      for (const binding of previous.bindings ?? []) {
        if (
          !bindings.some((next) => JSON.stringify(next.target) === JSON.stringify(binding.target))
        ) {
          bindings.push(binding);
        }
      }
    }
    const merged = { ...seed, bindings };
    if (index < 0) {
      target.push(merged);
    } else {
      target[index] = merged;
    }
  }
}

export function queryTagsFromData(data: object): string[] {
  return ((data as { __furinQueries?: QuerySeed[] }).__furinQueries ?? []).map((seed) =>
    queryTag(seed.identity)
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
      Object.entries(identity.scope).sort(([a], [b]) => {
        if (a === b) {
          return 0;
        }
        return a < b ? -1 : 1;
      }),
    ])
  );
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

import type { SyncQueryMap } from "@teyik0/furin/routes";
