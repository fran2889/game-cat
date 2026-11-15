import { describe, expect, it, vi } from "vitest";
import type { Rule } from "../../src/shared/rules.ts";
import {
  compileRules,
  evaluateRuleIds,
  gameMatchesRules,
  testRule,
  type RuleTarget,
} from "../../src/server/library/rule-evaluator.ts";
import { WORKED_CASES, WORKED_LIBRARY } from "../helpers/rule-fixture.ts";

function matches(rules: Rule[]): number[] {
  return evaluateRuleIds(rules, WORKED_LIBRARY);
}

function game(overrides: Partial<RuleTarget>): RuleTarget {
  return {
    appId: 1,
    name: "Game",
    playtimeMinutes: 0,
    installed: false,
    ownershipStatus: "owned",
    lastPlayedAt: null,
    releaseYear: null,
    metacriticScore: null,
    reviewScore: null,
    reviewTier: null,
    reviewCount: null,
    storefrontType: null,
    platforms: [],
    genres: [],
    categories: [],
    developers: [],
    publishers: [],
    tags: [],
    steamCollections: [],
    ...overrides,
  };
}

function rule(
  prefix: Rule["prefix"],
  field: Rule["field"],
  operator: Rule["operator"],
  value: Rule["value"],
): Rule {
  return { prefix, field, operator, value };
}

describe("§5.8 worked cases", () => {
  for (const worked of WORKED_CASES) {
    it(`case ${worked.number}: ${worked.proves}`, () => {
      expect(matches(worked.rules)).toEqual(worked.matches);
    });
  }

  it("produces ascending App IDs regardless of Rule order", () => {
    for (const worked of WORKED_CASES) {
      expect(matches([...worked.rules].reverse())).toEqual(worked.matches);
    }
  });
});

describe("compiled matcher equivalence", () => {
  /** The literal §5.5.2 grouping over the single-Rule predicate. */
  function reference(rules: readonly Rule[], target: RuleTarget): boolean {
    for (const rule of rules) {
      if (rule.prefix === "AND" && !testRule(rule, target)) {
        return false;
      }
    }
    if (rules.some((rule) => rule.prefix === "OR")) {
      if (!rules.some((rule) => rule.prefix === "OR" && testRule(rule, target))) {
        return false;
      }
    }
    for (const rule of rules) {
      if (rule.prefix === "NOT" && testRule(rule, target)) {
        return false;
      }
    }
    return true;
  }

  it("agrees with the literal grouping for every worked case and Game", () => {
    for (const worked of WORKED_CASES) {
      const compiled = compileRules(worked.rules);
      for (const target of WORKED_LIBRARY) {
        expect(compiled.matches(target), `case ${worked.number} app ${target.appId}`).toBe(
          reference(worked.rules, target),
        );
      }
    }
  });

  it("agrees on mixed prefix arrays, text normalization, dates, and list fields", () => {
    const cases: Rule[][] = [
      [rule("AND", "tag", "has", "  CO-OP "), rule("OR", "genre", "has", "Action")],
      [rule("NOT", "lastPlayed", "gte", "2024-01-01"), rule("AND", "name", "contains", "A")],
      [rule("OR", "platform", "has", "LINUX"), rule("OR", "steamCollection", "has", "favorite")],
      [rule("AND", "game", "in", [10, 620]), rule("NOT", "installed", "is", true)],
      [rule("AND", "reviewScore", "gte", 0), rule("NOT", "reviewCount", "lt", 0)],
      [rule("OR", "name", "is", "alpha"), rule("OR", "reviewTier", "is", "mixed")],
    ];
    for (const rules of cases) {
      const compiled = compileRules(rules);
      for (const target of WORKED_LIBRARY) {
        expect(compiled.matches(target), JSON.stringify(rules)).toBe(reference(rules, target));
      }
    }
  });
});

describe("global AND/OR/NOT grouping", () => {
  it("does not rescue a failed AND with an OR", () => {
    const rules = [
      rule("AND", "playtime", "gte", 600),
      rule("OR", "tag", "has", "Puzzle"),
      rule("OR", "tag", "has", "MOBA"),
    ];
    // 570 matches the OR but fails the AND, so it is still excluded.
    expect(matches(rules)).toEqual([620]);
  });

  it("requires both the AND group and an OR match", () => {
    const rules = [rule("AND", "tag", "has", "Action"), rule("OR", "name", "contains", "portal")];
    expect(matches(rules)).toEqual([]);
  });

  it("treats an only-NOT array as all Games minus the vetoes", () => {
    const rules = [
      rule("NOT", "tag", "has", "Co-op"),
      rule("NOT", "ownershipStatus", "is", "unknown"),
    ];
    expect(matches(rules)).toEqual([10, 570, 700, 800, 4000]);
  });

  it("lets a NOT veto override a matching OR", () => {
    const rules = [
      rule("OR", "tag", "has", "Co-op"),
      rule("OR", "tag", "has", "Puzzle"),
      rule("NOT", "installed", "is", true),
    ];
    expect(matches(rules)).toEqual([]);
  });

  it("matches nothing for contradictory AND Rules but keeps only-NOT rules usable", () => {
    expect(
      matches([rule("AND", "playtime", "gt", 1000), rule("AND", "playtime", "lt", 100)]),
    ).toEqual([]);
    expect(matches([rule("NOT", "game", "in", [10, 570, 620, 700, 800, 999, 4000])])).toEqual([]);
  });
});

describe("missing and unknown values", () => {
  const missingEverything = game({ installed: null });

  it("never satisfies a positive comparison against a missing value", () => {
    const positive: Rule[] = [
      rule("AND", "installed", "is", true),
      rule("AND", "installed", "is", false),
      rule("AND", "lastPlayed", "lt", "9999-12-31"),
      rule("AND", "releaseYear", "lt", 9999),
      rule("AND", "metacriticScore", "lt", 100),
      rule("AND", "reviewScore", "lt", 100),
      rule("AND", "reviewTier", "is", "Very Positive"),
      rule("AND", "reviewCount", "lt", 10),
      rule("AND", "storefrontType", "is", "game"),
      rule("AND", "platform", "has", "windows"),
      rule("AND", "genre", "has", "Action"),
      rule("AND", "category", "has", "Co-op"),
      rule("AND", "developer", "has", "Valve"),
      rule("AND", "publisher", "has", "Valve"),
      rule("AND", "tag", "has", "Co-op"),
      rule("AND", "steamCollection", "has", "favorite"),
    ];
    for (const entry of positive) {
      expect(gameMatchesRules([entry], missingEverything), JSON.stringify(entry)).toBe(false);
    }
  });

  it("lets a NOT Rule match every missing value", () => {
    const negated: Rule[] = [
      rule("NOT", "installed", "is", true),
      rule("NOT", "installed", "is", false),
      rule("NOT", "lastPlayed", "lt", "9999-12-31"),
      rule("NOT", "releaseYear", "lt", 9999),
      rule("NOT", "metacriticScore", "lt", 100),
      rule("NOT", "reviewScore", "lt", 100),
      rule("NOT", "reviewTier", "is", "Very Positive"),
      rule("NOT", "reviewCount", "lt", 10),
      rule("NOT", "storefrontType", "is", "game"),
      rule("NOT", "platform", "has", "windows"),
      rule("NOT", "genre", "has", "Action"),
      rule("NOT", "category", "has", "Co-op"),
      rule("NOT", "developer", "has", "Valve"),
      rule("NOT", "publisher", "has", "Valve"),
      rule("NOT", "tag", "has", "Co-op"),
      rule("NOT", "steamCollection", "has", "favorite"),
    ];
    for (const entry of negated) {
      expect(gameMatchesRules([entry], missingEverything), JSON.stringify(entry)).toBe(true);
    }
  });

  it("does not coerce a null installed value to false", () => {
    const unknownInstalled = game({ installed: null });
    expect(gameMatchesRules([rule("AND", "installed", "is", false)], unknownInstalled)).toBe(false);
    expect(gameMatchesRules([rule("NOT", "installed", "is", false)], unknownInstalled)).toBe(true);
  });

  it("matches a known-zero review count but not an unknown one", () => {
    expect(gameMatchesRules([rule("AND", "reviewCount", "lt", 10)], game({ reviewCount: 0 }))).toBe(
      true,
    );
    expect(
      gameMatchesRules([rule("AND", "reviewCount", "lt", 10)], game({ reviewCount: null })),
    ).toBe(false);
    expect(gameMatchesRules([rule("NOT", "reviewCount", "lt", 10)], game({ reviewCount: 0 }))).toBe(
      false,
    );
    expect(
      gameMatchesRules([rule("NOT", "reviewCount", "lt", 10)], game({ reviewCount: null })),
    ).toBe(true);
  });

  it("treats playtime 0 as a real value, not as missing", () => {
    expect(gameMatchesRules([rule("AND", "playtime", "lt", 1)], game({ playtimeMinutes: 0 }))).toBe(
      true,
    );
  });
});

describe("normalization and comparison semantics", () => {
  it("NFC-normalizes, trims, and lowercases text and enums", () => {
    const cafe = game({ name: "Cafe\u0301 Deluxe", genres: ["Cafe\u0301"], reviewTier: "Mixed" });
    expect(gameMatchesRules([rule("AND", "name", "is", "  café deluxe  ")], cafe)).toBe(true);
    expect(gameMatchesRules([rule("AND", "name", "contains", "CAFÉ")], cafe)).toBe(true);
    expect(gameMatchesRules([rule("AND", "genre", "has", "CAFÉ")], cafe)).toBe(true);
    expect(gameMatchesRules([rule("AND", "reviewTier", "is", "mixed")], cafe)).toBe(true);
  });

  it("normalizes ownershipStatus and platform enum values case-insensitively", () => {
    const target = game({
      ownershipStatus: "local_only",
      platforms: ["windows", "linux"],
    });
    expect(gameMatchesRules([rule("AND", "ownershipStatus", "is", " Local_Only ")], target)).toBe(
      true,
    );
    expect(gameMatchesRules([rule("AND", "platform", "has", "LINUX")], target)).toBe(true);
  });

  it("keeps Steam Collection IDs case-sensitive and unnormalized", () => {
    const target = game({ steamCollections: ["favorite", "uc-CoOp"] });
    expect(gameMatchesRules([rule("AND", "steamCollection", "has", "favorite")], target)).toBe(
      true,
    );
    expect(gameMatchesRules([rule("AND", "steamCollection", "has", "Favorite")], target)).toBe(
      false,
    );
    expect(gameMatchesRules([rule("AND", "steamCollection", "has", "uc-CoOp")], target)).toBe(true);
    expect(gameMatchesRules([rule("AND", "steamCollection", "has", "uc-coop")], target)).toBe(
      false,
    );
  });

  it("ignores Tag votes because only names participate in matching", () => {
    const lowVotes = game({ tags: ["Co-op"] });
    expect(gameMatchesRules([rule("AND", "tag", "has", "co-op")], lowVotes)).toBe(true);
  });

  it("compares lastPlayed as a UTC calendar date", () => {
    const midnight = game({ lastPlayedAt: Date.UTC(2024, 0, 1, 0, 0, 0) / 1000 });
    const lastSecond = game({ lastPlayedAt: Date.UTC(2023, 11, 31, 23, 59, 59) / 1000 });
    expect(gameMatchesRules([rule("AND", "lastPlayed", "lt", "2024-01-01")], midnight)).toBe(false);
    expect(gameMatchesRules([rule("AND", "lastPlayed", "lt", "2024-01-01")], lastSecond)).toBe(
      true,
    );
    expect(gameMatchesRules([rule("AND", "lastPlayed", "lte", "2024-01-01")], midnight)).toBe(true);
    expect(gameMatchesRules([rule("AND", "lastPlayed", "gte", "2024-01-01")], midnight)).toBe(true);
    expect(
      gameMatchesRules(
        [rule("AND", "lastPlayed", "gte", "2024-01-01")],
        game({ lastPlayedAt: null }),
      ),
    ).toBe(false);
  });

  it("matches a hand-picked App ID list and tolerates IDs outside the Library", () => {
    expect(gameMatchesRules([rule("AND", "game", "in", [1, 999_999])], game({ appId: 1 }))).toBe(
      true,
    );
    expect(gameMatchesRules([rule("AND", "game", "in", [2])], game({ appId: 1 }))).toBe(false);
    expect(gameMatchesRules([rule("NOT", "game", "in", [1])], game({ appId: 1 }))).toBe(false);
  });

  it("never matches a dynamic or unknown Steam Collection", () => {
    const target = game({ steamCollections: ["uc-static"] });
    expect(gameMatchesRules([rule("AND", "steamCollection", "has", "uc-dynamic")], target)).toBe(
      false,
    );
    expect(gameMatchesRules([rule("AND", "steamCollection", "has", "uc-unknown")], target)).toBe(
      false,
    );
  });
});

describe("purity", () => {
  it("is deterministic across repeated runs and does not mutate its inputs", () => {
    const rules = WORKED_CASES[1]!.rules;
    const snapshot = JSON.stringify({ rules, library: WORKED_LIBRARY });
    const first = evaluateRuleIds(rules, WORKED_LIBRARY);
    for (let index = 0; index < 5; index += 1) {
      expect(evaluateRuleIds(rules, WORKED_LIBRARY)).toEqual(first);
    }
    expect(JSON.stringify({ rules, library: WORKED_LIBRARY })).toBe(snapshot);
  });

  it("does not read the clock or draw randomness", () => {
    const now = vi.spyOn(Date, "now");
    const random = vi.spyOn(Math, "random");
    for (const worked of WORKED_CASES) {
      evaluateRuleIds(worked.rules, WORKED_LIBRARY);
    }
    expect(now).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    now.mockRestore();
    random.mockRestore();
  });
});
