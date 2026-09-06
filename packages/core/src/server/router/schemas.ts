import type { RuntimeRoute } from "../../client/internal/runtime-types.ts";
import {
  type FurinSchema,
  getSchemaValidator,
  parseQueryFromURL,
  parseQueryStandardSchema,
} from "../../shared/elysia-contract.ts";
import {
  collectSearchDefaults,
  type SearchParamsInput,
  type SearchRouteMetadata,
} from "../../shared/search-params.ts";
import { buildRouteRegex } from "./patterns.ts";

import { mergeRouteSchemas } from "./schema-merge.ts";

interface UnknownObject {
  [key: string]: unknown;
}

interface QueryKeyMap {
  [key: string]: 1;
}

/**
 * Parses the `?path=` argument of `/_furin/data`, rejecting absolute /
 * protocol-relative inputs that would let a caller smuggle a foreign origin
 * into the synthetic loader request.
 *
 * Returns `{ url, pathname }` on success, or `undefined` when the input is
 * unsafe (the caller should reply 400). `new URL(rawPath, base)` ignores the
 * base when `rawPath` is itself absolute, so without these prefix and origin
 * checks a value like `https://evil.com/foo` would propagate to
 * `syntheticRequest.url`.
 *
 * @internal Exported for unit testing.
 */
export function parseDataEndpointPath(rawPath: string): { url: URL; pathname: string } | undefined {
  if (rawPath.includes("://") || rawPath.startsWith("//")) {
    return;
  }
  let url: URL;
  try {
    url = new URL(rawPath, "http://localhost");
  } catch {
    return;
  }
  if (url.origin !== "http://localhost") {
    return;
  }
  return { pathname: url.pathname, url };
}

function isObjectSchema(schema: unknown): schema is UnknownObject {
  return !!schema && typeof schema === "object";
}

function isStandardSchema(schema: unknown): boolean {
  return isObjectSchema(schema) && "~standard" in schema;
}

function collectQueryArrayKeys(schema: unknown): QueryKeyMap | undefined {
  if (!(isObjectSchema(schema) && isObjectSchema(schema.properties))) {
    return;
  }

  const keys: QueryKeyMap = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    const effectiveSchema = findEffectiveAnyOfMember(value, "array") ?? value;
    if (isObjectSchema(effectiveSchema) && effectiveSchema.type === "array") {
      keys[key] = 1;
    }
  }

  return Object.keys(keys).length > 0 ? keys : undefined;
}

function collectQueryObjectKeys(schema: unknown): QueryKeyMap | undefined {
  if (!(isObjectSchema(schema) && isObjectSchema(schema.properties))) {
    return;
  }

  const keys: QueryKeyMap = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    const effectiveSchema = findEffectiveAnyOfMember(value, "object") ?? value;
    if (isObjectSchema(effectiveSchema) && effectiveSchema.type === "object") {
      keys[key] = 1;
    }
  }

  return Object.keys(keys).length > 0 ? keys : undefined;
}

function findEffectiveAnyOfMember(
  schema: unknown,
  type: "array" | "object"
): UnknownObject | undefined {
  if (!(isObjectSchema(schema) && Array.isArray(schema.anyOf))) {
    return;
  }

  for (const member of schema.anyOf) {
    if (isObjectSchema(member) && member.type === type) {
      return member;
    }
  }
}

function parseJsonQueryObjects(
  query: UnknownObject,
  objectKeys: QueryKeyMap | undefined
): UnknownObject {
  if (!objectKeys) {
    return query;
  }

  const parsed = { ...query };
  for (const key of Object.keys(objectKeys)) {
    const value = parsed[key];
    if (typeof value !== "string") {
      continue;
    }
    try {
      parsed[key] = JSON.parse(value);
    } catch {
      parsed[key] = value;
    }
  }
  return parsed;
}

export type ParseRouteQueryResult =
  | { ok: true; query: SearchParamsInput }
  | { errors: unknown; ok: false };

export type ParseRouteParamsResult =
  | { ok: true; params: UnknownObject }
  | { errors: unknown; ok: false };

type RouteInputValidationResult =
  | { ok: true; value: UnknownObject }
  | { errors: unknown; ok: false };

async function validateRouteInput(
  input: UnknownObject,
  schema: FurinSchema
): Promise<RouteInputValidationResult> {
  if (isStandardSchema(schema)) {
    const validator = getSchemaValidator(schema, { dynamic: true });
    const checked = await validator?.Check(input);
    if (checked && typeof checked === "object" && "issues" in checked) {
      return { errors: checked.issues, ok: false };
    }
    if (checked && typeof checked === "object" && "value" in checked) {
      return { ok: true, value: checked.value as UnknownObject };
    }
    return { ok: true, value: input };
  }

  const inputWithDefaults = applySchemaDefaults(schema as UnknownObject, input);
  const validator = getSchemaValidator(schema, { coerce: true, dynamic: true });
  if (validator?.Check(inputWithDefaults) === false) {
    return { errors: [...(validator?.Errors(inputWithDefaults) ?? [])], ok: false };
  }

  return {
    ok: true,
    value: (validator?.parse(inputWithDefaults) ?? inputWithDefaults) as UnknownObject,
  };
}

/**
 * Parses and validates a logical route URL's search string for the synthetic
 * `/_furin/data` request path. This keeps SPA navigations aligned with the
 * Elysia guard used by the full SSR route.
 *
 * @internal Exported for unit testing.
 */
export async function parseRouteQuery(
  url: URL,
  schema: FurinSchema | undefined
): Promise<ParseRouteQueryResult> {
  if (!schema) {
    return { ok: true, query: parseQueryFromURL(url.search, 1) as SearchParamsInput };
  }

  const rawQuery = isStandardSchema(schema)
    ? (parseQueryStandardSchema(url.search, 1) as UnknownObject)
    : parseJsonQueryObjects(
        parseQueryFromURL(url.search, 1, collectQueryArrayKeys(schema)) as UnknownObject,
        collectQueryObjectKeys(schema)
      );
  const result = await validateRouteInput(rawQuery, schema);
  return result.ok ? { ok: true, query: result.value as SearchParamsInput } : result;
}

/**
 * Validates and coerces path params for the synthetic `/_furin/data` request
 * path. This mirrors the composed Elysia route schema so SPA loaders receive
 * the same values as full SSR loaders.
 *
 * @internal Exported for unit testing.
 */
export async function parseRouteParams(
  params: UnknownObject,
  schema: FurinSchema | undefined
): Promise<ParseRouteParamsResult> {
  if (!schema) {
    return { ok: true, params };
  }

  const result = await validateRouteInput(params, schema);
  return result.ok ? { ok: true, params: result.value } : result;
}

export function createSearchRouteMetadata(
  routes: Array<{ pattern: string; routeChain: RuntimeRoute[] }>
): SearchRouteMetadata[] {
  const metadata: SearchRouteMetadata[] = [];
  for (const route of routes) {
    const searchDefaults = collectSearchDefaults(mergeRouteSchemas(route.routeChain, "query"));
    if (!searchDefaults) {
      continue;
    }
    metadata.push({
      pattern: route.pattern,
      regex: buildRouteRegex(route.pattern).regex,
      searchDefaults,
    });
  }
  return metadata;
}

/**
 * Applies top-level `default` values from a TypeBox TObject schema to a
 * values record. Used in the `/_furin/data` endpoint so loaders see the same
 * defaulted query objects that the SSR path produces via Elysia's guard.
 */
export function applySchemaDefaults(
  schema: UnknownObject | undefined,
  values: UnknownObject
): UnknownObject {
  if (!schema || typeof schema !== "object") {
    return values;
  }
  const s = schema;
  if (s.type !== "object" || !s.properties || typeof s.properties !== "object") {
    return values;
  }
  const result = { ...values };
  const properties = s.properties as { [key: string]: UnknownObject };
  for (const [key, propSchema] of Object.entries(properties)) {
    if (
      !(key in result) &&
      propSchema &&
      typeof propSchema === "object" &&
      "default" in propSchema
    ) {
      result[key] = propSchema.default;
    }
  }
  return result;
}
