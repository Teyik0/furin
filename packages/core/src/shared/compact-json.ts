type JsonScalar = boolean | null | number | string;
type JsonValue = JsonObject | JsonScalar | JsonValue[];

interface JsonObject {
  [key: string]: JsonValue;
}

const COMPACT_JSON_TAG = "__furin_json_v1__";
type CompactJsonEnvelope = [typeof COMPACT_JSON_TAG, JsonObject];

function isJsonValue(value: unknown, seen: WeakSet<object>): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0);
  }
  if (typeof value !== "object" || seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!(descriptor && "value" in descriptor && isJsonValue(descriptor.value, seen))) {
        return false;
      }
    }
    return true;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && isJsonValue(descriptor.value, seen);
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isJsonValue(value, new WeakSet())
  );
}

export function serializeCompactJsonLine(value: unknown): string | undefined {
  if (!isJsonObject(value)) {
    return;
  }
  const envelope: CompactJsonEnvelope = [COMPACT_JSON_TAG, value];
  return `${JSON.stringify(envelope)}\n`;
}

export function parseCompactJsonLine(value: unknown): JsonObject | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value[0] !== COMPACT_JSON_TAG ||
    !isJsonObject(value[1])
  ) {
    return;
  }
  return value[1];
}
