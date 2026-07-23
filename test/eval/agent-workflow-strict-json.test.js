import { describe, expect, it } from "vitest";
import { parseStrictJson } from "../../scripts/eval-strict-json.mjs";

describe("agent workflow strict evidence JSON", () => {
  it("accepts ordinary nested JSON", () => {
    expect(parseStrictJson(
      "{\"a\":1,\"nested\":{\"b\":[true,null,\"x\"]}}",
      "fixture",
    )).toEqual({ a: 1, nested: { b: [true, null, "x"] } });
  });

  it("rejects duplicate keys at any object depth", () => {
    expect(() => parseStrictJson(
      "{\"a\":1,\"nested\":{\"b\":1,\"b\":2}}",
      "fixture",
    )).toThrow(/duplicate object key "b"/);
  });
});
