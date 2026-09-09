import { t } from "elysia";
import type { RuntimeRoute } from "../../client/internal/runtime-types.ts";
import { type FurinSchema, isTypeBoxObjectSchema } from "../../shared/elysia-contract.ts";

interface SchemaObject {
  [key: string]: unknown;
}

const TOBJECT_STRUCTURAL_KEYS = new Set(["type", "properties", "required"]);
export function mergeRouteSchemas(
  routeChain: RuntimeRoute[],
  key: "params" | "query"
): FurinSchema | undefined {
  const schemas = routeChain.flatMap((route) => (route[key] ? [route[key] as SchemaObject] : []));

  if (schemas.length === 0) {
    return;
  }
  if (schemas.length === 1) {
    return schemas[0] as FurinSchema;
  }
  if (schemas.some((schema) => !isTypeBoxObjectSchema(schema))) {
    throw new Error(
      `[furin] Merging ${key} schemas across the route chain requires TypeBox in V1. Use TypeBox for parent/child ${key}, or define ${key} only on leaf routes.`
    );
  }

  const properties = Object.assign(
    {},
    ...schemas.map((schema) => schema.properties as SchemaObject)
  );
  const options = Object.assign(
    {},
    ...schemas.map((schema) =>
      Object.fromEntries(
        Object.entries(schema).filter(([name]) => !TOBJECT_STRUCTURAL_KEYS.has(name))
      )
    )
  );

  return t.Object(properties, options) as FurinSchema;
}
