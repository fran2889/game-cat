import { describe, expect, it } from "vitest";
import {
  addSelectionToGameRule,
  changeRuleField,
  emptyRule,
  formatMinutesAsHours,
  gameRuleIds,
  mergedGameRuleIds,
  parseHoursToMinutes,
  platformsInRules,
  prefixCounts,
  togglePlatformRule,
  validateCollectionName,
} from "../../src/client/rule-editor.ts";
import { validateRules, type Rule } from "../../src/shared/rules.ts";

describe("editor Rule construction", () => {
  it("starts a new Rule with an allowed Operator and a typed value", () => {
    const tag = emptyRule("tag");
    expect(tag).toEqual({ prefix: "AND", field: "tag", operator: "has", value: "" });
    expect(emptyRule("playtime")).toEqual({
      prefix: "AND",
      field: "playtime",
      operator: "lt",
      value: 0,
    });
    expect(emptyRule("installed").value).toBe(true);
    expect(emptyRule("ownershipStatus").value).toBe("owned");
    expect(emptyRule("platform").value).toBe("windows");
    expect(emptyRule("game").value).toEqual([]);
  });

  it("resets the Operator and value when the Field changes", () => {
    const changed = changeRuleField(
      { prefix: "OR", field: "name", operator: "contains", value: "portal" },
      "installed",
    );
    expect(changed).toEqual({ prefix: "OR", field: "installed", operator: "is", value: true });
    expect(validateRules([changed]).fieldErrors).toEqual({});
  });
});

describe("editor Rule gate", () => {
  it("accepts an empty draft and a valid typed Rule", () => {
    expect(validateRules([])).toEqual({ rules: [], fieldErrors: {} });
    expect(
      validateRules([{ prefix: "AND", field: "playtime", operator: "lt", value: 600 }]),
    ).toEqual({
      rules: [{ prefix: "AND", field: "playtime", operator: "lt", value: 600 }],
      fieldErrors: {},
    });
  });

  it("reports the shared validator's dotted errors without client-only rules", () => {
    const result = validateRules([
      { prefix: "AND", field: "tag", operator: "has", value: "" },
      { prefix: "AND", field: "playtime", operator: "is", value: 600 },
      { prefix: "AND", field: "installed", operator: "is", value: "true" },
    ]);
    expect(result.fieldErrors).toEqual({
      "rules.0.value": "must not be empty",
      "rules.1.operator": "playtime accepts lt, lte, gt, gte",
      "rules.2.value": "must be true or false",
    });
    expect(result.rules).toEqual([
      { prefix: "AND", field: "tag", operator: "has", value: "" },
      { prefix: "AND", field: "installed", operator: "is", value: "true" },
    ]);
  });
});

describe("prefix counts", () => {
  it("counts every Rule by Prefix", () => {
    const rules: Rule[] = [
      { prefix: "AND", field: "tag", operator: "has", value: "Co-op" },
      { prefix: "AND", field: "playtime", operator: "lt", value: 600 },
      { prefix: "OR", field: "tag", operator: "has", value: "Puzzle" },
      { prefix: "NOT", field: "installed", operator: "is", value: true },
    ];
    expect(prefixCounts(rules)).toEqual({ AND: 2, OR: 1, NOT: 1 });
    expect(prefixCounts([])).toEqual({ AND: 0, OR: 0, NOT: 0 });
  });
});

describe("collection name validation", () => {
  it("accepts 1-80 code points after trim", () => {
    expect(validateCollectionName("Short co-op games")).toBeNull();
    expect(validateCollectionName("  Padded name  ")).toBeNull();
    expect(validateCollectionName("a".repeat(80))).toBeNull();
  });

  it("rejects blank, over-long, and control-bearing names", () => {
    expect(validateCollectionName("")).toContain("name");
    expect(validateCollectionName("   ")).toContain("name");
    expect(validateCollectionName("a".repeat(81))).toContain("80");
    expect(validateCollectionName("bad\u0000name")).toContain("control");
  });

  it("counts Unicode code points rather than UTF-16 units", () => {
    expect(validateCollectionName("😀".repeat(80))).toBeNull();
    expect(validateCollectionName("😀".repeat(81))).toContain("80");
  });

  it("counts NFC-normalized code points like the API", () => {
    expect(validateCollectionName("e\u0301".repeat(80))).toBeNull();
    expect(validateCollectionName("e\u0301".repeat(81))).toContain("80");
  });
});

describe("playtime hours conversion", () => {
  it("converts decimal hours to integer minutes", () => {
    expect(parseHoursToMinutes("1")).toBe(60);
    expect(parseHoursToMinutes("1.5")).toBe(90);
    expect(parseHoursToMinutes("0.25")).toBe(15);
    expect(parseHoursToMinutes("0")).toBe(0);
    expect(parseHoursToMinutes(" 2 ")).toBe(120);
    expect(parseHoursToMinutes("3602")).toBe(216_120);
  });

  it("rejects empty, negative, and non-numeric input", () => {
    for (const value of ["", " ", "-1", "abc", "1e3", "1.2.3"]) {
      expect(parseHoursToMinutes(value), value).toBeNull();
    }
  });

  it("formats stored minutes back to a compact hours field", () => {
    expect(formatMinutesAsHours(60)).toBe("1");
    expect(formatMinutesAsHours(90)).toBe("1.5");
    expect(formatMinutesAsHours(15)).toBe("0.25");
    expect(formatMinutesAsHours(3602)).toBe("60.03");
    expect(formatMinutesAsHours(0)).toBe("0");
  });
});

describe("platform quick-add rules", () => {
  const base: Rule[] = [{ prefix: "AND", field: "tag", operator: "has", value: "Co-op" }];

  it("emits one has Rule per selected platform", () => {
    const withWindows = togglePlatformRule(base, "windows");
    expect(withWindows).toEqual([
      ...base,
      { prefix: "AND", field: "platform", operator: "has", value: "windows" },
    ]);
    const withLinux = togglePlatformRule(withWindows, "linux");
    expect(platformsInRules(withLinux)).toEqual(["windows", "linux"]);
  });

  it("removes the platform Rule when the platform is deselected", () => {
    const withWindows = togglePlatformRule(base, "windows");
    expect(togglePlatformRule(withWindows, "windows")).toEqual(base);
    expect(platformsInRules(togglePlatformRule(withWindows, "windows"))).toEqual([]);
  });

  it("ignores non-platform Rules with the same value", () => {
    const rules: Rule[] = [
      { prefix: "AND", field: "tag", operator: "has", value: "windows" },
      { prefix: "AND", field: "platform", operator: "has", value: "windows" },
    ];
    expect(togglePlatformRule(rules, "windows")).toEqual([rules[0]!]);
  });
});

describe("game Rule values", () => {
  it("reads an ascending App ID list from a game Rule", () => {
    expect(gameRuleIds({ prefix: "AND", field: "game", operator: "in", value: [620, 10] })).toEqual(
      [620, 10],
    );
  });

  it("returns an empty list for non-game Rules", () => {
    expect(gameRuleIds({ prefix: "AND", field: "tag", operator: "has", value: "Co-op" })).toEqual(
      [],
    );
  });

  it("adds one ascending AND game Rule when none exists", () => {
    const rules: Rule[] = [{ prefix: "AND", field: "tag", operator: "has", value: "Co-op" }];
    expect(addSelectionToGameRule(rules, [620, 10, 620])).toEqual([
      ...rules,
      { prefix: "AND", field: "game", operator: "in", value: [10, 620] },
    ]);
  });

  it("appends to the existing game Rule without creating a second one", () => {
    const rules: Rule[] = [
      {
        prefix: "OR",
        field: "game",
        operator: "in",
        value: [620],
      },
      { prefix: "AND", field: "tag", operator: "has", value: "Co-op" },
    ];
    const next = addSelectionToGameRule(rules, [10, 620]);
    expect(next).toEqual([
      { prefix: "OR", field: "game", operator: "in", value: [10, 620] },
      rules[1],
    ]);
    expect(next?.filter((rule) => rule.field === "game")).toHaveLength(1);
    expect(mergedGameRuleIds(rules, [10, 620])).toEqual([10, 620]);
  });

  it("returns null and reports the merged size when the game Rule would exceed 1,000", () => {
    const rules: Rule[] = [
      {
        prefix: "AND",
        field: "game",
        operator: "in",
        value: Array.from({ length: 999 }, (_, index) => index + 1),
      },
    ];
    expect(mergedGameRuleIds(rules, [1_001, 1_002])).toHaveLength(1_001);
    expect(addSelectionToGameRule(rules, [1_001, 1_002])).toBeNull();
    expect(
      addSelectionToGameRule(
        [],
        Array.from({ length: 1_000 }, (_, i) => i + 1),
      ),
    ).toHaveLength(1);
    expect(
      addSelectionToGameRule(
        [],
        Array.from({ length: 1_001 }, (_, i) => i + 1),
      ),
    ).toBeNull();
  });
});
