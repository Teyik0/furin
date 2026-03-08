// biome-ignore-all lint/suspicious/noMisplacedAssertion: helper
import { expect } from "bun:test";

export function expectDefined<T>(value: T): asserts value is NonNullable<T> {
  expect(value).not.toBeUndefined();
  expect(value).not.toBeNull();
}
