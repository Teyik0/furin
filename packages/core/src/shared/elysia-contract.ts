import { getSchemaValidator as elysiaGetSchemaValidator } from "elysia";
import {
  parseQueryFromURL as elysiaParseQueryFromURL,
  parseQueryStandardSchema as elysiaParseQueryStandardSchema,
} from "elysia/parse-query";
import { TypeCompiler as ElysiaTypeCompiler } from "elysia/type-system";
import type { AnySchema, UnwrapSchema } from "elysia/types";

export const parseQueryFromURL = elysiaParseQueryFromURL;
export const parseQueryStandardSchema = elysiaParseQueryStandardSchema;
export const TypeCompiler = ElysiaTypeCompiler;

interface SchemaObject {
  [key: string]: unknown;
}

const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

/**
 * Central compatibility boundary for Elysia types used by Furin's public DX.
 * Contract tests must fail before changes to these projections reach callers.
 */
export type FurinSchema = AnySchema;

interface FurinSchemaValidator {
  Check: (value: unknown) => unknown;
  Errors: (value: unknown) => Iterable<unknown>;
  parse: (value: unknown) => unknown;
}

interface FurinSchemaValidatorOptions {
  coerce?: boolean;
  dynamic?: boolean;
}

export function getSchemaValidator(
  schema: FurinSchema,
  options: FurinSchemaValidatorOptions
): FurinSchemaValidator | undefined {
  return elysiaGetSchemaValidator(schema, options) as FurinSchemaValidator | undefined;
}

export type FurinUnwrap<Schema extends FurinSchema | undefined> = UnwrapSchema<Schema>;

export type ElysiaRoutes<App extends { "~Routes": unknown }> = App["~Routes"];

export type ElysiaRouteLeaf<App> = App extends { "~Routes": infer Routes }
  ? Routes extends { get: infer Leaf }
    ? Leaf
    : never
  : never;

export type ElysiaRouteParams<Leaf> = Leaf extends { params: infer Params } ? Params : never;

export type ElysiaRouteQuery<Leaf> = Leaf extends { query: infer Query } ? Query : never;

export function isTypeBoxObjectSchema(schema: unknown): schema is SchemaObject {
  if (schema === null || typeof schema !== "object") {
    return false;
  }
  const candidate = schema as SchemaObject & { [key: symbol]: unknown };
  return candidate[TYPEBOX_KIND] === "Object" || candidate["~kind"] === "Object";
}
