import { expect, test } from "bun:test";
import { queryFromTag, queryTag } from "../../../src/shared/sync-query.ts";

test.each(["broken", "{}", "[1,[]]", '["cards",null]', '["cards",[["id",{}]]]'])(
  "malformed reserved cache tag %s is ignored",
  (suffix) => {
    expect(queryFromTag(`__furin.query:${suffix}`)).toBeUndefined();
  }
);

test("scope keys are ordered consistently without locale collation", () => {
  const identity = { id: "cards", scope: { z: 1, ä: 2, a: 3 } };
  expect(queryTag(identity)).toBe('__furin.query:["cards",[["a",3],["z",1],["ä",2]]]');
  expect(queryFromTag(queryTag(identity))).toEqual(identity);
});
