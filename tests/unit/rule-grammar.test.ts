import { describe, expect, it } from "vitest";
import {
  RULE_FIELDS,
  RULE_FIELD_DEFINITIONS,
  RULE_OPERATORS,
  RULE_PREFIXES,
  normalizeRuleText,
  ruleFieldDefinition,
  validatePreviewRequest,
  validateRules,
} from "../../src/shared/rules.ts";
import { normalizeNameKey } from "../../src/shared/names.ts";

function errorsFor(value: unknown): Record<string, string> {
  return validateRules(value).fieldErrors;
}

describe("Shared normalization", () => {
  it("uses one helper for Rule text and name keys", () => {
    expect(normalizeRuleText).toBe(normalizeNameKey);
    expect(normalizeRuleText("  Café  ")).toBe("café");
  });

  it("rejects an explicit null Rules value but accepts an omitted one", () => {
    expect(errorsFor(undefined)).toEqual({});
    expect(errorsFor(null)).toEqual({ rules: "must be an array" });
  });
});

describe("Rule field registry", () => {
  it("lists exactly the documented Fields in §5.3 order", () => {
    expect([...RULE_FIELDS]).toEqual([
      "name",
      "playtime",
      "installed",
      "ownershipStatus",
      "lastPlayed",
      "releaseYear",
      "metacriticScore",
      "reviewScore",
      "reviewTier",
      "reviewCount",
      "storefrontType",
      "platform",
      "genre",
      "category",
      "developer",
      "publisher",
      "tag",
      "steamCollection",
      "game",
    ]);
    expect(RULE_FIELD_DEFINITIONS).toHaveLength(RULE_FIELDS.length);
    expect([...RULE_PREFIXES]).toEqual(["AND", "OR", "NOT"]);
    expect([...RULE_OPERATORS]).toEqual(["is", "contains", "has", "in", "lt", "lte", "gt", "gte"]);
  });

  it("gives every Field its documented value type and Operator set", () => {
    const expected: Record<string, string[]> = {
      name: ["is", "contains"],
      playtime: ["lt", "lte", "gt", "gte"],
      installed: ["is"],
      ownershipStatus: ["is"],
      lastPlayed: ["lt", "lte", "gt", "gte"],
      releaseYear: ["lt", "lte", "gt", "gte"],
      metacriticScore: ["lt", "lte", "gt", "gte"],
      reviewScore: ["lt", "lte", "gt", "gte"],
      reviewTier: ["is"],
      reviewCount: ["lt", "lte", "gt", "gte"],
      storefrontType: ["is"],
      platform: ["has"],
      genre: ["has"],
      category: ["has"],
      developer: ["has"],
      publisher: ["has"],
      tag: ["has"],
      steamCollection: ["has"],
      game: ["in"],
    };
    for (const [field, operators] of Object.entries(expected)) {
      expect(ruleFieldDefinition(field as never)?.operators, field).toEqual(operators);
    }
  });

  it("records a source and missing-value behavior for every Field", () => {
    for (const definition of RULE_FIELD_DEFINITIONS) {
      expect(definition.source.length, definition.field).toBeGreaterThan(0);
      expect(definition.missing.length, definition.field).toBeGreaterThan(0);
      expect(definition.label.length, definition.field).toBeGreaterThan(0);
    }
  });
});

describe("validateRules", () => {
  it("accepts every valid Field/Operator pair and preserves the supplied values", () => {
    const rules = [
      { prefix: "AND", field: "name", operator: "is", value: "Portal 2" },
      { prefix: "AND", field: "playtime", operator: "lt", value: 600 },
      { prefix: "AND", field: "installed", operator: "is", value: true },
      { prefix: "OR", field: "ownershipStatus", operator: "is", value: "Local_Only" },
      { prefix: "NOT", field: "lastPlayed", operator: "gte", value: "2024-01-01" },
      { prefix: "AND", field: "releaseYear", operator: "lte", value: 2011 },
      { prefix: "AND", field: "metacriticScore", operator: "gt", value: 90 },
      { prefix: "AND", field: "reviewScore", operator: "gte", value: 90 },
      { prefix: "AND", field: "reviewTier", operator: "is", value: "Very Positive" },
      { prefix: "AND", field: "reviewCount", operator: "lt", value: 10 },
      { prefix: "AND", field: "storefrontType", operator: "is", value: "game" },
      { prefix: "AND", field: "platform", operator: "has", value: "Linux" },
      { prefix: "AND", field: "genre", operator: "has", value: "Action" },
      { prefix: "AND", field: "category", operator: "has", value: "Co-op" },
      { prefix: "AND", field: "developer", operator: "has", value: "Valve" },
      { prefix: "AND", field: "publisher", operator: "has", value: "Valve" },
      { prefix: "AND", field: "tag", operator: "has", value: "Co-op" },
      { prefix: "AND", field: "steamCollection", operator: "has", value: "uc-CoOp" },
      { prefix: "AND", field: "game", operator: "in", value: [620, 4000] },
    ];
    const result = validateRules(rules);
    expect(result.fieldErrors).toEqual({});
    expect(result.rules).toEqual(rules);
  });

  it("accepts an empty or missing Rules array", () => {
    expect(validateRules([]).fieldErrors).toEqual({});
    expect(validateRules(undefined).rules).toEqual([]);
    expect(validateRules({}).rules).toEqual([]);
  });

  it("rejects an unknown or lowercase prefix at rules.N.prefix", () => {
    expect(errorsFor([{ prefix: "and", field: "tag", operator: "has", value: "Co-op" }])).toEqual({
      "rules.0.prefix": expect.any(String),
    });
    expect(errorsFor([{ field: "tag", operator: "has", value: "Co-op" }])).toEqual({
      "rules.0.prefix": expect.any(String),
    });
  });

  it("rejects an unknown Field at rules.N.field", () => {
    expect(errorsFor([{ prefix: "AND", field: "tags", operator: "has", value: "Co-op" }])).toEqual({
      "rules.0.field": expect.any(String),
    });
    expect(errorsFor([{ prefix: "AND", field: "Name", operator: "is", value: "x" }])).toEqual({
      "rules.0.field": expect.any(String),
    });
  });

  it("rejects an unknown or disallowed Operator at rules.N.operator", () => {
    expect(errorsFor([{ prefix: "AND", field: "playtime", operator: "is", value: 1 }])).toEqual({
      "rules.0.operator": expect.any(String),
    });
    expect(errorsFor([{ prefix: "AND", field: "tag", operator: "like", value: "x" }])).toEqual({
      "rules.0.operator": expect.any(String),
    });
    expect(errorsFor([{ prefix: "AND", field: "name", operator: "has", value: "x" }])).toEqual({
      "rules.0.operator": expect.any(String),
    });
    expect(errorsFor([{ prefix: "AND", field: "game", operator: "has", value: [1] }])).toEqual({
      "rules.0.operator": expect.any(String),
    });
  });

  it("rejects the wrong JSON type for a value at rules.N.value", () => {
    expect(errorsFor([{ prefix: "AND", field: "playtime", operator: "lt", value: "600" }])).toEqual(
      {
        "rules.0.value": expect.any(String),
      },
    );
    expect(
      errorsFor([{ prefix: "AND", field: "installed", operator: "is", value: "true" }]),
    ).toEqual({ "rules.0.value": expect.any(String) });
    expect(errorsFor([{ prefix: "AND", field: "tag", operator: "has", value: ["Co-op"] }])).toEqual(
      { "rules.0.value": expect.any(String) },
    );
    expect(errorsFor([{ prefix: "AND", field: "game", operator: "in", value: 620 }])).toEqual({
      "rules.0.value": expect.any(String),
    });
  });

  it("enforces numeric bounds and integer types", () => {
    const cases: Array<Record<string, unknown>> = [
      { prefix: "AND", field: "playtime", operator: "lt", value: -1 },
      { prefix: "AND", field: "playtime", operator: "lt", value: 1.5 },
      { prefix: "AND", field: "playtime", operator: "lt", value: Number.MAX_SAFE_INTEGER + 1 },
      { prefix: "AND", field: "releaseYear", operator: "lt", value: 999 },
      { prefix: "AND", field: "releaseYear", operator: "lt", value: 10_000 },
      { prefix: "AND", field: "releaseYear", operator: "lt", value: 2011.5 },
      { prefix: "AND", field: "metacriticScore", operator: "lt", value: 101 },
      { prefix: "AND", field: "metacriticScore", operator: "lt", value: -1 },
      { prefix: "AND", field: "reviewScore", operator: "lt", value: 101 },
      { prefix: "AND", field: "reviewCount", operator: "lt", value: -1 },
      { prefix: "AND", field: "reviewCount", operator: "lt", value: 1.2 },
    ];
    for (const rule of cases) {
      expect(errorsFor([rule]), JSON.stringify(rule)).toEqual({
        "rules.0.value": expect.any(String),
      });
    }
    expect(errorsFor([{ prefix: "AND", field: "reviewScore", operator: "gte", value: 0 }])).toEqual(
      {},
    );
    expect(
      errorsFor([{ prefix: "AND", field: "reviewScore", operator: "lte", value: 100 }]),
    ).toEqual({});
    expect(
      errorsFor([{ prefix: "AND", field: "releaseYear", operator: "gte", value: 1000 }]),
    ).toEqual({});
    expect(
      errorsFor([{ prefix: "AND", field: "releaseYear", operator: "lte", value: 9999 }]),
    ).toEqual({});
  });

  it("rejects a lastPlayed value that is not a real UTC date", () => {
    for (const value of [
      "2024-02-30",
      "2023-02-29",
      "2024-13-01",
      "2024-00-10",
      "2024-1-1",
      "0000-01-01",
      "2024-01-01T00:00:00Z",
      "",
    ]) {
      expect(
        errorsFor([{ prefix: "AND", field: "lastPlayed", operator: "lt", value }]),
        value,
      ).toEqual({ "rules.0.value": expect.any(String) });
    }
    for (const value of ["2024-01-01", "2024-02-29", "1970-01-01", "9999-12-31"]) {
      expect(
        errorsFor([{ prefix: "AND", field: "lastPlayed", operator: "lt", value }]),
        value,
      ).toEqual({});
    }
  });

  it("rejects empty, over-long, or control-bearing text values", () => {
    for (const value of ["", "   ", "a".repeat(201), "bad\u0000value", "bad\u009fvalue"]) {
      expect(
        errorsFor([{ prefix: "AND", field: "name", operator: "contains", value }]),
        JSON.stringify(value),
      ).toEqual({ "rules.0.value": expect.any(String) });
    }
    expect(
      errorsFor([{ prefix: "AND", field: "name", operator: "contains", value: "a".repeat(200) }]),
    ).toEqual({});
    // Whitespace around a non-empty value is valid and matches the trimmed form.
    expect(
      errorsFor([{ prefix: "AND", field: "name", operator: "contains", value: "  Portal  " }]),
    ).toEqual({});
  });

  it("rejects an empty, over-long, or non-string steamCollection ID", () => {
    for (const value of ["", "x".repeat(129), 42]) {
      expect(
        errorsFor([{ prefix: "AND", field: "steamCollection", operator: "has", value }]),
        JSON.stringify(value),
      ).toEqual({ "rules.0.value": expect.any(String) });
    }
    expect(
      errorsFor([
        { prefix: "AND", field: "steamCollection", operator: "has", value: "x".repeat(128) },
      ]),
    ).toEqual({});
    // IDs are opaque: mixed case and unknown IDs are accepted.
    expect(
      errorsFor([{ prefix: "AND", field: "steamCollection", operator: "has", value: "uc-CoOp" }]),
    ).toEqual({});
    expect(
      errorsFor([
        { prefix: "AND", field: "steamCollection", operator: "has", value: "uc-missing" },
      ]),
    ).toEqual({});
  });

  it("validates the game App ID list", () => {
    const invalid: unknown[] = [[], [0], [-1], [1.5], ["620"], [620, 620], [620, 0]];
    for (const value of invalid) {
      expect(
        errorsFor([{ prefix: "AND", field: "game", operator: "in", value }]),
        JSON.stringify(value),
      ).toEqual({ "rules.0.value": expect.any(String) });
    }
    expect(
      errorsFor([
        {
          prefix: "AND",
          field: "game",
          operator: "in",
          value: Array.from({ length: 1001 }, (_, index) => index + 1),
        },
      ]),
    ).toEqual({ "rules.0.value": expect.any(String) });
    expect(
      errorsFor([{ prefix: "AND", field: "game", operator: "in", value: [620, 4000] }]),
    ).toEqual({});
    expect(
      errorsFor([{ prefix: "AND", field: "game", operator: "in", value: [1, 999_999] }]),
    ).toEqual({});
  });

  it("rejects an unknown closed-enum value for ownershipStatus and platform", () => {
    expect(
      errorsFor([{ prefix: "AND", field: "ownershipStatus", operator: "is", value: "borrowed" }]),
    ).toEqual({ "rules.0.value": expect.any(String) });
    expect(
      errorsFor([{ prefix: "AND", field: "platform", operator: "has", value: "switch" }]),
    ).toEqual({ "rules.0.value": expect.any(String) });
    for (const value of ["owned", "local_only", "unknown", "LOCAL_ONLY"]) {
      expect(
        errorsFor([{ prefix: "AND", field: "ownershipStatus", operator: "is", value }]),
        value,
      ).toEqual({});
    }
  });

  it("allows unknown Tag, Genre, Category, Developer, Publisher, Storefront Type, and Review Tier values", () => {
    for (const [field, value] of [
      ["tag", "Definitely Not A Tag"],
      ["genre", "Made Up Genre"],
      ["category", "Made Up Category"],
      ["developer", "Made Up Studio"],
      ["publisher", "Made Up Publisher"],
      ["storefrontType", "soundtrack"],
      ["reviewTier", "Mostly Negative"],
    ] as const) {
      expect(
        errorsFor([
          {
            prefix: "AND",
            field,
            operator:
              field === "tag" ||
              field === "genre" ||
              field === "category" ||
              field === "developer" ||
              field === "publisher"
                ? "has"
                : "is",
            value,
          },
        ]),
        field,
      ).toEqual({});
    }
  });

  it("rejects more than 100 Rules at rules", () => {
    const rule = { prefix: "AND", field: "tag", operator: "has", value: "Co-op" };
    expect(errorsFor(Array.from({ length: 101 }, () => rule))).toEqual({
      rules: expect.any(String),
    });
    expect(errorsFor(Array.from({ length: 100 }, () => rule))).toEqual({});
  });

  it("rejects a serialized value over 16 KiB at rules.N.value", () => {
    const ids = Array.from({ length: 1000 }, (_, index) => Number.MAX_SAFE_INTEGER - index);
    const big = { prefix: "AND", field: "game", operator: "in", value: ids };
    expect(validateRules([big]).fieldErrors["rules.0.value"]).toBeDefined();
    expect(validateRules([{ ...big, value: ids.slice(0, 10) }]).fieldErrors).toEqual({});
  });

  it("reports every dotted path for multiple invalid Rules", () => {
    const errors = errorsFor([
      { prefix: "AND", field: "nope", operator: "is", value: 1 },
      { prefix: "AND", field: "playtime", operator: "is", value: 5 },
      { prefix: "OR", field: "game", operator: "in", value: [] },
    ]);
    expect(Object.keys(errors).sort()).toEqual([
      "rules.0.field",
      "rules.1.operator",
      "rules.2.value",
    ]);
  });
});

describe("validatePreviewRequest", () => {
  it("defaults page, pageSize, sort, and order", () => {
    const result = validatePreviewRequest({ rules: [] });
    expect(result.fieldErrors).toEqual({});
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(60);
    expect(result.sort).toBe("name");
    expect(result.order).toBe("asc");
  });

  it("accepts the documented body and keeps its page and sort", () => {
    const result = validatePreviewRequest({
      rules: [{ prefix: "AND", field: "playtime", operator: "lt", value: 60 }],
      page: 2,
      pageSize: 60,
      sort: "playtime",
      order: "desc",
    });
    expect(result.fieldErrors).toEqual({});
    expect(result).toMatchObject({ page: 2, pageSize: 60, sort: "playtime", order: "desc" });
  });

  it("rejects an invalid page, pageSize, sort, or order", () => {
    expect(validatePreviewRequest({ page: 0 }).fieldErrors).toEqual({ page: expect.any(String) });
    expect(validatePreviewRequest({ page: 1.5 }).fieldErrors).toEqual({ page: expect.any(String) });
    expect(validatePreviewRequest({ pageSize: 0 }).fieldErrors).toEqual({
      pageSize: expect.any(String),
    });
    expect(validatePreviewRequest({ pageSize: 201 }).fieldErrors).toEqual({
      pageSize: expect.any(String),
    });
    expect(validatePreviewRequest({ sort: "reviewScore" }).fieldErrors).toEqual({
      sort: expect.any(String),
    });
    expect(validatePreviewRequest({ order: "up" }).fieldErrors).toEqual({
      order: expect.any(String),
    });
  });
});
