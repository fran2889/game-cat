import { describe, expect, it } from "vitest";
import { RULE_FIELD_DEFINITIONS, describeRule, type Rule } from "../../src/shared/rules.ts";

describe("Rule descriptions", () => {
  it("gives every Field its own describer", () => {
    for (const definition of RULE_FIELD_DEFINITIONS) {
      expect(definition.describe, definition.field).toBeTypeOf("function");
    }
  });

  it("describes the common Field, Operator, and value combinations", () => {
    expect(describeRule({ prefix: "AND", field: "tag", operator: "has", value: "Co-op" })).toBe(
      'Tagged "Co-op"',
    );
    expect(describeRule({ prefix: "AND", field: "playtime", operator: "lte", value: 1_200 })).toBe(
      "Playtime ≤ 20 h",
    );
    expect(
      describeRule({ prefix: "AND", field: "name", operator: "contains", value: "portal" }),
    ).toBe('Name contains "portal"');
    expect(describeRule({ prefix: "AND", field: "name", operator: "is", value: "Portal 2" })).toBe(
      'Named "Portal 2"',
    );
    expect(describeRule({ prefix: "AND", field: "installed", operator: "is", value: false })).toBe(
      "Not installed",
    );
    expect(
      describeRule({ prefix: "AND", field: "platform", operator: "has", value: "linux" }),
    ).toBe("Platform: Linux");
    expect(describeRule({ prefix: "AND", field: "reviewScore", operator: "gte", value: 90 })).toBe(
      "Review score ≥ 90",
    );
    expect(describeRule({ prefix: "AND", field: "genre", operator: "has", value: "Action" })).toBe(
      "Genre: Action",
    );
  });

  it("resolves Steam collection names and counts Game lists", () => {
    const steam: Rule = {
      prefix: "AND",
      field: "steamCollection",
      operator: "has",
      value: "friday-crew",
    };
    expect(describeRule(steam)).toBe("Steam collection: friday-crew");
    expect(
      describeRule(steam, {
        collectionName: (id) => (id === "friday-crew" ? "Friday crew" : undefined),
      }),
    ).toBe("Steam collection: Friday crew");
    expect(describeRule({ prefix: "AND", field: "game", operator: "in", value: [620] })).toBe(
      "Game list: 1 game",
    );
    expect(describeRule({ prefix: "AND", field: "game", operator: "in", value: [620, 730] })).toBe(
      "Game list: 2 games",
    );
  });

  it("falls back to the Field and Operator when there is no usable value", () => {
    expect(describeRule({ prefix: "AND", field: "tag", operator: "has", value: "" })).toBe(
      "Tag has…",
    );
    expect(describeRule({ prefix: "AND", field: "playtime", operator: "lt", value: -1 })).toBe(
      "Playtime is less than…",
    );
    expect(describeRule({ prefix: "AND", field: "game", operator: "in", value: [] })).toBe(
      "Game list is one of…",
    );
  });

  it("describes ownership, dates, and open enum fields from the registry", () => {
    expect(
      describeRule({
        prefix: "AND",
        field: "ownershipStatus",
        operator: "is",
        value: "local_only",
      }),
    ).toBe("Ownership: Local only");
    expect(
      describeRule({ prefix: "AND", field: "lastPlayed", operator: "gte", value: "2024-01-01" }),
    ).toBe("Last played ≥ 2024-01-01");
    expect(
      describeRule({ prefix: "AND", field: "reviewTier", operator: "is", value: "Very Positive" }),
    ).toBe('Review tier is "Very Positive"');
  });
});
