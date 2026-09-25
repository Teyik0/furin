import type { RuntimeRoute } from "../../client/internal/runtime-types.ts";
import { type FurinSchema, getSchemaValidator } from "../../shared/elysia-contract.ts";
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

function decodeQueryPart(value: string): string {
  return new URLSearchParams(`value=${value}`).get("value") ?? "";
}

function parseArrayQueryValue(raw: string, decoded: string, repeated: boolean): string[] {
  const rawBracketed = raw.startsWith("[") && raw.endsWith("]");
  const decodedBracketed = decoded.startsWith("[") && decoded.endsWith("]");
  if (repeated && !rawBracketed && !decodedBracketed) {
    return [decoded];
  }
  if (decoded === "[]") {
    return [];
  }
  if (rawBracketed) {
    return raw.slice(1, -1).split(",").map(decodeQueryPart);
  }
  if (decodedBracketed) {
    return decoded.slice(1, -1).split(",");
  }
  return raw.includes(",") ? raw.split(",").map(decodeQueryPart) : [decoded];
}

function parseQueryFromURL(search: string, arrayKeys?: QueryKeyMap): UnknownObject {
  const query: UnknownObject = Object.create(null);
  if (!arrayKeys) {
    for (const [key, value] of new URLSearchParams(search)) {
      query[key] = value;
    }
    return query;
  }
  for (const pair of search.slice(1).split("&")) {
    const entry = new URLSearchParams(pair).entries().next().value;
    if (!entry) {
      continue;
    }
    const [key, value] = entry;
    if (!arrayKeys[key]) {
      query[key] = value;
      continue;
    }
    const equalIndex = pair.indexOf("=");
    const rawValue = equalIndex === -1 ? "" : pair.slice(equalIndex + 1);
    const previous = query[key];
    const values = parseArrayQueryValue(rawValue, value, Array.isArray(previous));
    if (Array.isArray(previous)) {
      previous.push(...values);
    } else {
      query[key] = values;
    }
  }
  return query;
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
  return collectQueryKeys(schema, "array");
}

function collectQueryObjectKeys(schema: unknown): QueryKeyMap | undefined {
  return collectQueryKeys(schema, "object");
}

function collectQueryKeys(schema: unknown, type: "array" | "object"): QueryKeyMap | undefined {
  if (!isObjectSchema(schema)) {
    return;
  }

  const keys: QueryKeyMap = {};
  if (isObjectSchema(schema.properties)) {
    for (const [key, value] of Object.entries(schema.properties)) {
      if (hasSchemaType(value, type)) {
        keys[key] = 1;
      }
    }
  }

  for (const keyword of ["allOf", "anyOf"] as const) {
    const members = schema[keyword];
    if (!Array.isArray(members)) {
      continue;
    }
    for (const member of members) {
      Object.assign(keys, collectQueryKeys(member, type));
    }
  }

  return Object.keys(keys).length > 0 ? keys : undefined;
}

function hasSchemaType(schema: unknown, type: "array" | "object"): boolean {
  if (!isObjectSchema(schema)) {
    return false;
  }
  if (schema.type === type) {
    return true;
  }
  for (const keyword of ["allOf", "anyOf"] as const) {
    const members = schema[keyword];
    if (Array.isArray(members) && members.some((member) => hasSchemaType(member, type))) {
      return true;
    }
  }
  return false;
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

function coerceUnionValue(members: unknown[], value: unknown): unknown {
  for (const member of members) {
    const candidate = coerceSchemaValue(member, value);
    const validator = getSchemaValidator(member as FurinSchema);
    if (validator?.Check(candidate)) {
      return candidate;
    }
  }
  return value;
}

function coerceObjectValue(properties: UnknownObject, value: UnknownObject): UnknownObject {
  const coerced = { ...value };
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (key in coerced) {
      coerced[key] = coerceSchemaValue(propertySchema, coerced[key]);
    }
  }
  return coerced;
}

function coerceStringValue(schema: UnknownObject, value: string): unknown {
  if (value.length === 0) {
    return value;
  }
  if (schema.type === "boolean") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    return value;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const number = Number(value);
    if (Number.isFinite(number) && (schema.type !== "integer" || Number.isInteger(number))) {
      return number;
    }
  }
  return value;
}

function coerceSchemaValue(schema: unknown, value: unknown): unknown {
  if (!isObjectSchema(schema)) {
    return value;
  }
  if (Array.isArray(schema.anyOf)) {
    return coerceUnionValue(schema.anyOf, value);
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.reduce((candidate, member) => coerceSchemaValue(member, candidate), value);
  }
  if (schema.type === "object" && isObjectSchema(schema.properties) && isObjectSchema(value)) {
    return coerceObjectValue(schema.properties, value);
  }
  if (schema.type === "array" && Array.isArray(value)) {
    return value.map((entry) => coerceSchemaValue(schema.items, entry));
  }
  return typeof value === "string" ? coerceStringValue(schema, value) : value;
}

export function coerceRouteInput(schema: FurinSchema, value: UnknownObject): UnknownObject {
  return coerceSchemaValue(schema, value) as UnknownObject;
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
  schema: FurinSchema,
  type: "params" | "query"
): Promise<RouteInputValidationResult> {
  const inputWithDefaults = isStandardSchema(schema)
    ? input
    : applySchemaDefaults(schema as UnknownObject, input);
  const valueToValidate = isStandardSchema(schema)
    ? inputWithDefaults
    : coerceRouteInput(schema, inputWithDefaults);
  const validator = getSchemaValidator(schema);
  try {
    const parsed = await validator?.parse(valueToValidate, type);
    return {
      ok: true,
      value: (parsed ?? valueToValidate) as UnknownObject,
    };
  } catch {
    return { errors: [...(validator?.Errors(valueToValidate) ?? [])], ok: false };
  }
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
    return { ok: true, query: parseQueryFromURL(url.search) as SearchParamsInput };
  }

  const rawQuery = isStandardSchema(schema)
    ? parseQueryFromURL(url.search)
    : parseJsonQueryObjects(
        parseQueryFromURL(url.search, collectQueryArrayKeys(schema)),
        collectQueryObjectKeys(schema)
      );
  const result = await validateRouteInput(rawQuery, schema, "query");
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

  const result = await validateRouteInput(params, schema, "params");
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
