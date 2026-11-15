import type { Rule } from "../../src/shared/rules.ts";
import type { RuleTarget } from "../../src/server/library/rule-evaluator.ts";

/**
 * The §5.8 fixture: seven Games, static Favorites/Hidden and user Collections,
 * one dynamic Collection, and one unknown Collection ID. The same data seeds
 * the preview integration tests, so evaluator and endpoint coverage agree.
 */

function utcSeconds(date: string): number {
  const [year, month, day] = date.split("-").map((part) => Number.parseInt(part, 10));
  return Date.UTC(year!, month! - 1, day!) / 1000;
}

function target(overrides: Partial<RuleTarget> & Pick<RuleTarget, "appId" | "name">): RuleTarget {
  return {
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

export const WORKED_LIBRARY: readonly RuleTarget[] = [
  target({
    appId: 10,
    name: "Alpha",
    ownershipStatus: "owned",
    installed: true,
    playtimeMinutes: 3602,
    lastPlayedAt: utcSeconds("2025-01-02"),
    releaseYear: 2012,
    metacriticScore: null,
    reviewScore: 85,
    reviewTier: "Very Positive",
    reviewCount: 1000,
    storefrontType: "game",
    platforms: ["windows", "linux"],
    genres: ["Action", "Free to Play"],
    categories: ["Multi-player"],
    developers: ["Valve"],
    publishers: ["Valve"],
    tags: ["FPS", "Shooter"],
    steamCollections: ["favorite"],
  }),
  target({
    appId: 570,
    name: "Gamma",
    ownershipStatus: "owned",
    installed: false,
    playtimeMinutes: 0,
    releaseYear: 2013,
    metacriticScore: 90,
    reviewScore: 80,
    reviewTier: "Very Positive",
    reviewCount: 2000,
    storefrontType: "game",
    platforms: ["windows", "mac", "linux"],
    genres: ["Action", "Strategy"],
    categories: ["Multi-player"],
    developers: ["Valve"],
    publishers: ["Valve"],
    tags: ["MOBA", "Free to Play"],
    steamCollections: ["uc-moba"],
  }),
  target({
    appId: 620,
    name: "Portal 2",
    ownershipStatus: "owned",
    installed: true,
    playtimeMinutes: 612,
    lastPlayedAt: utcSeconds("2024-01-02"),
    releaseYear: 2011,
    metacriticScore: 95,
    reviewScore: 98,
    reviewTier: "Overwhelmingly Positive",
    reviewCount: 5000,
    storefrontType: "game",
    platforms: ["windows", "mac", "linux"],
    genres: ["Action", "Adventure"],
    categories: ["Single-player", "Co-op"],
    developers: ["Valve"],
    publishers: ["Valve"],
    tags: ["Puzzle", "Co-op"],
    steamCollections: ["favorite", "uc-coop"],
  }),
  target({
    appId: 700,
    name: "Zeta",
    ownershipStatus: "owned",
    installed: true,
    playtimeMinutes: 120,
    lastPlayedAt: utcSeconds("2023-06-15"),
    releaseYear: 2020,
    metacriticScore: 70,
    reviewScore: 60,
    reviewTier: "Mixed",
    reviewCount: 50,
    storefrontType: "dlc",
    platforms: ["windows"],
    genres: ["Action"],
    categories: ["Single-player"],
    developers: ["Valve"],
    publishers: ["Valve"],
    tags: ["Action"],
  }),
  target({
    appId: 800,
    name: "Theta",
    ownershipStatus: "owned",
    installed: false,
    playtimeMinutes: 0,
    releaseYear: 2019,
    metacriticScore: 80,
    reviewScore: null,
    reviewTier: null,
    reviewCount: 0,
    storefrontType: "game",
    platforms: ["windows"],
    genres: ["Indie"],
    categories: ["Single-player"],
    developers: ["IndieDev"],
    publishers: ["IndiePub"],
  }),
  target({
    appId: 999,
    name: "Epsilon",
    ownershipStatus: "unknown",
    installed: null,
    playtimeMinutes: 0,
    storefrontType: null,
    steamCollections: ["hidden"],
  }),
  target({
    appId: 4000,
    name: "Delta",
    ownershipStatus: "local_only",
    installed: false,
    playtimeMinutes: 0,
    releaseYear: 2006,
    metacriticScore: null,
    reviewScore: null,
    reviewTier: null,
    reviewCount: null,
    storefrontType: "game",
    platforms: ["windows", "mac", "linux"],
    genres: ["Indie"],
    categories: ["Single-player"],
    developers: ["Facepunch"],
    publishers: ["Valve"],
    tags: ["Sandbox"],
    steamCollections: ["uc-sandbox"],
  }),
];

/** Static Steam Collections in the fixture; `uc-dynamic` has no members. */
export const WORKED_STEAM_COLLECTIONS: ReadonlyArray<{
  id: string;
  name: string;
  kind: string;
  isDynamic: boolean;
}> = [
  { id: "favorite", name: "Favorites", kind: "favorite", isDynamic: false },
  { id: "hidden", name: "Hidden", kind: "hidden", isDynamic: false },
  { id: "uc-moba", name: "MOBA", kind: "user", isDynamic: false },
  { id: "uc-coop", name: "Co-op", kind: "user", isDynamic: false },
  { id: "uc-sandbox", name: "Sandbox", kind: "user", isDynamic: false },
  { id: "uc-dynamic", name: "Dynamic picks", kind: "user", isDynamic: true },
];

function rule(
  prefix: "AND" | "OR" | "NOT",
  field: Rule["field"],
  operator: Rule["operator"],
  value: Rule["value"],
): Rule {
  return { prefix, field, operator, value };
}

export interface WorkedCase {
  number: number;
  rules: Rule[];
  matches: number[];
  proves: string;
}

export const WORKED_CASES: readonly WorkedCase[] = [
  {
    number: 1,
    rules: [],
    matches: [10, 570, 620, 700, 800, 999, 4000],
    proves: "Empty Rules match all",
  },
  {
    number: 2,
    rules: [rule("AND", "tag", "has", "Co-op"), rule("AND", "playtime", "lt", 1000)],
    matches: [620],
    proves: "AND requires every Rule",
  },
  {
    number: 3,
    rules: [rule("AND", "tag", "has", "Co-op"), rule("AND", "playtime", "gt", 1000)],
    matches: [],
    proves: "One failed AND rejects the Game",
  },
  {
    number: 4,
    rules: [rule("OR", "tag", "has", "Puzzle"), rule("OR", "tag", "has", "MOBA")],
    matches: [570, 620],
    proves: "OR needs one match",
  },
  {
    number: 5,
    rules: [rule("OR", "tag", "has", "Horror"), rule("OR", "tag", "has", "Racing")],
    matches: [],
    proves: "OR with no match rejects",
  },
  {
    number: 6,
    rules: [
      rule("AND", "installed", "is", true),
      rule("OR", "genre", "has", "Adventure"),
      rule("OR", "genre", "has", "Strategy"),
    ],
    matches: [620],
    proves: "AND and OR combine",
  },
  {
    number: 7,
    rules: [rule("NOT", "tag", "has", "Co-op")],
    matches: [10, 570, 700, 800, 999, 4000],
    proves: "NOT vetoes",
  },
  {
    number: 8,
    rules: [rule("NOT", "installed", "is", true)],
    matches: [570, 800, 999, 4000],
    proves: "NOT includes false and unknown",
  },
  {
    number: 9,
    rules: [rule("NOT", "tag", "has", "Horror")],
    matches: [10, 570, 620, 700, 800, 999, 4000],
    proves: "Missing Tags do not trigger a veto",
  },
  {
    number: 10,
    rules: [rule("AND", "metacriticScore", "gte", 90)],
    matches: [570, 620],
    proves: "Numeric bound",
  },
  {
    number: 11,
    rules: [rule("AND", "metacriticScore", "lt", 95)],
    matches: [570, 700, 800],
    proves: "Missing scores are excluded",
  },
  {
    number: 12,
    rules: [rule("AND", "installed", "is", false)],
    matches: [570, 800, 4000],
    proves: "null is not false",
  },
  {
    number: 13,
    rules: [rule("NOT", "installed", "is", false)],
    matches: [10, 620, 700, 999],
    proves: "null survives the NOT",
  },
  {
    number: 14,
    rules: [rule("AND", "playtime", "gte", 600), rule("AND", "playtime", "lt", 3600)],
    matches: [620],
    proves: "Integer range",
  },
  {
    number: 15,
    rules: [rule("AND", "lastPlayed", "lt", "2025-01-01")],
    matches: [620, 700],
    proves: "UTC date comparison",
  },
  {
    number: 16,
    rules: [rule("AND", "lastPlayed", "lte", "2024-01-02")],
    matches: [620, 700],
    proves: "Inclusive date bound",
  },
  {
    number: 17,
    rules: [rule("NOT", "lastPlayed", "lt", "2025-01-01")],
    matches: [10, 570, 800, 999, 4000],
    proves: "Never-played survives the NOT",
  },
  {
    number: 18,
    rules: [rule("AND", "reviewScore", "gte", 90)],
    matches: [620],
    proves: "Review Score",
  },
  {
    number: 19,
    rules: [rule("AND", "reviewTier", "is", "very positive")],
    matches: [10, 570],
    proves: "Case-insensitive tier",
  },
  {
    number: 20,
    rules: [rule("AND", "reviewCount", "gte", 3000)],
    matches: [620],
    proves: "Review Count",
  },
  {
    number: 21,
    rules: [rule("AND", "game", "in", [620, 4000])],
    matches: [620, 4000],
    proves: "Hand-picked list",
  },
  {
    number: 22,
    rules: [rule("NOT", "game", "in", [620])],
    matches: [10, 570, 700, 800, 999, 4000],
    proves: "Negated hand-picked list",
  },
  {
    number: 23,
    rules: [rule("AND", "steamCollection", "has", "favorite")],
    matches: [10, 620],
    proves: "Static Steam Collection by ID",
  },
  {
    number: 24,
    rules: [rule("AND", "steamCollection", "has", "uc-dynamic")],
    matches: [],
    proves: "Dynamic Collection never matches",
  },
  {
    number: 25,
    rules: [rule("AND", "steamCollection", "has", "uc-missing")],
    matches: [],
    proves: "Unknown Collection never matches",
  },
  {
    number: 26,
    rules: [rule("AND", "genre", "has", "action")],
    matches: [10, 570, 620, 700],
    proves: "Multi-valued membership, case-insensitive",
  },
  {
    number: 27,
    rules: [rule("AND", "platform", "has", "linux")],
    matches: [10, 570, 620, 4000],
    proves: "Multi-valued platform",
  },
  {
    number: 28,
    rules: [rule("AND", "name", "contains", "portal")],
    matches: [620],
    proves: "Normalized substring",
  },
  {
    number: 29,
    rules: [rule("AND", "storefrontType", "is", "game")],
    matches: [10, 570, 620, 800, 4000],
    proves: "Open enum, excludes DLC and unknown",
  },
  {
    number: 30,
    rules: [rule("AND", "ownershipStatus", "is", "local_only")],
    matches: [4000],
    proves: "Enum equality",
  },
  {
    number: 31,
    rules: [rule("AND", "playtime", "gt", 1000), rule("AND", "playtime", "lt", 100)],
    matches: [],
    proves: "Contradictory Rules",
  },
  {
    number: 32,
    rules: [rule("AND", "tag", "has", "Co-op"), rule("AND", "tag", "has", "Co-op")],
    matches: [620],
    proves: "Duplicate Rules",
  },
  {
    number: 33,
    rules: [rule("AND", "reviewCount", "lt", 10)],
    matches: [800],
    proves: "Known zero matches; unknown does not",
  },
  {
    number: 34,
    rules: [rule("NOT", "reviewCount", "lt", 10)],
    matches: [10, 570, 620, 700, 999, 4000],
    proves: "Unknown survives; known zero is vetoed",
  },
  {
    number: 35,
    rules: [rule("AND", "releaseYear", "gte", 2011)],
    matches: [10, 570, 620, 700, 800],
    proves: "Year range",
  },
  {
    number: 36,
    rules: [rule("AND", "name", "is", "portal 2")],
    matches: [620],
    proves: "Normalized exact text",
  },
];
