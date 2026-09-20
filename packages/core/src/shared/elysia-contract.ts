import { type AnySchema, type UnwrapSchema, Validator } from "elysia";
import { parseQueryFromURL as elysiaParseQueryFromURL } from "elysia/parse-query";

export const parseQueryFromURL = elysiaParseQueryFromURL;

interface SchemaObject {
  [key: string]: unknown;
}

interface TypeBoxObjectSchema extends SchemaObject {
  properties: SchemaObject;
}

const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

/**
 * Central compatibility boundary for Elysia types used by Furin's public DX.
 * Contract tests must fail before changes to these projections reach callers.
 */
export type FurinSchema = AnySchema;

interface FurinSchemaValidator {
  Check: (value: unknown) => boolean;
  Errors: (value: unknown) => Iterable<unknown>;
  parse: (value: unknown, type: "params" | "query") => Promise<unknown>;
}

export function getSchemaValidator(schema: FurinSchema): FurinSchemaValidator | undefined {
  const validator = Validator.create(schema);
  if (validator === undefined) {
    return;
  }
  return {
    Check: (value) => validator.Check(value),
    Errors: (value) => validator.Errors(value),
    parse: async (value, type) => (validator.From ? await validator.From(value, type) : value),
  };
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

export function isTypeBoxObjectSchema(schema: unknown): schema is TypeBoxObjectSchema {
  if (schema === null || typeof schema !== "object") {
    return false;
  }
  const candidate = schema as SchemaObject & { [key: symbol]: unknown };
  return (
    (candidate[TYPEBOX_KIND] === "Object" || candidate["~kind"] === "Object") &&
    candidate.properties !== null &&
    typeof candidate.properties === "object"
  );
}
