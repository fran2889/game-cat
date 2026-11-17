import { describe, expect, it } from "vitest";
import { asRecord } from "../../src/shared/records.ts";

describe("asRecord", () => {
  it("narrows plain objects and rejects everything else", () => {
    expect(asRecord({ value: 1 })).toEqual({ value: 1 });
    for (const value of [null, undefined, [], "text", 1, true]) {
      expect(asRecord(value)).toBeNull();
    }
  });
});
