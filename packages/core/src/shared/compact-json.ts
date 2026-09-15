type JsonScalar = boolean | null | number | string;
type JsonValue = JsonObject | JsonScalar | JsonValue[];

interface JsonObject {
  [key: string]: JsonValue;
}

interface CompactJsonEnvelope {
  __furinJson: 1;
  data: JsonObject;
}

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
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value && isJsonValue(value[index], seen))) {
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
  const object = value as { [key: string]: unknown };
  return keys.every((key) => isJsonValue(object[key], seen));
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
  const envelope: CompactJsonEnvelope = { __furinJson: 1, data: value };
  return `${JSON.stringify(envelope)}\n`;
}

export function parseCompactJsonLine(value: unknown): JsonObject | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const envelope = value as { __furinJson?: unknown; data?: unknown };
  if (envelope.__furinJson !== 1 || !isJsonObject(envelope.data)) {
    return;
  }
  return envelope.data;
}
