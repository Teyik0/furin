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
      Object.entries(identity.scope).sort(([a], [b]) => a.localeCompare(b)),
    ])
  );
}

export function queryFromTag(tag: string): QueryIdentity | undefined {
  if (!tag.startsWith(PREFIX)) {
    return;
  }
  const [id, scope] = JSON.parse(tag.slice(PREFIX.length)) as [
    string,
    [string, string | number | boolean | null][],
  ];
  return { id, scope: Object.fromEntries(scope) };
}

export function queryUrl(url: string, origin: string | undefined): string {
  const parsed = new URL(url, origin);
  parsed.searchParams.sort();
  return (parsed.origin === origin ? "" : parsed.origin) + parsed.pathname + parsed.search;
}

import type { SyncQueryMap } from "@teyik0/furin/routes";
