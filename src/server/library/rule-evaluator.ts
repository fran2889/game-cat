import {
  dateOrdinal,
  normalizeRuleText,
  ruleFieldDefinition,
  timestampDateOrdinal,
  type Rule,
  type RuleFieldDefinition,
} from "../../shared/rules.ts";

/**
 * The pure Rule evaluator (spec §5.5).
 *
 * It reads only the in-memory Game projection handed to it: no clock, random,
 * network, or database access. Missing values stay `null` or empty lists; they
 * are never coerced to `0`, `false`, `""`, or `[]` in a way that satisfies a
 * positive comparison.
 */

export interface RuleTarget {
  appId: number;
  name: string;
  playtimeMinutes: number;
  installed: boolean | null;
  ownershipStatus: "owned" | "local_only" | "unknown";
  /** Unix seconds, or `null` when never played or not yet known. */
  lastPlayedAt: number | null;
  releaseYear: number | null;
  metacriticScore: number | null;
  reviewScore: number | null;
  reviewTier: string | null;
  reviewCount: number | null;
  storefrontType: string | null;
  platforms: readonly string[];
  genres: readonly string[];
  categories: readonly string[];
  developers: readonly string[];
  publishers: readonly string[];
  tags: readonly string[];
  /** Static Steam Collection IDs only; dynamic Collections have no membership. */
  steamCollections: readonly string[];
}

type SingleValue = string | number | boolean | null;

function readSingle(field: Rule["field"], game: RuleTarget): SingleValue {
  switch (field) {
    case "name":
      return game.name;
    case "playtime":
      return game.playtimeMinutes;
    case "installed":
      return game.installed;
    case "ownershipStatus":
      return game.ownershipStatus;
    case "lastPlayed":
      return game.lastPlayedAt === null ? null : timestampDateOrdinal(game.lastPlayedAt);
    case "releaseYear":
      return game.releaseYear;
    case "metacriticScore":
      return game.metacriticScore;
    case "reviewScore":
      return game.reviewScore;
    case "reviewTier":
      return game.reviewTier;
    case "reviewCount":
      return game.reviewCount;
    case "storefrontType":
      return game.storefrontType;
    default:
      return null;
  }
}

function readList(field: Rule["field"], game: RuleTarget): readonly string[] {
  switch (field) {
    case "platform":
      return game.platforms;
    case "genre":
      return game.genres;
    case "category":
      return game.categories;
    case "developer":
      return game.developers;
    case "publisher":
      return game.publishers;
    case "tag":
      return game.tags;
    case "steamCollection":
      return game.steamCollections;
    default:
      return [];
  }
}

function isListField(definition: RuleFieldDefinition): boolean {
  return (
    definition.valueKind === "multiText" ||
    definition.valueKind === "steamCollection" ||
    definition.field === "platform"
  );
}

function compareNumbers(actual: number, value: unknown, operator: Rule["operator"]): boolean {
  if (typeof value !== "number") {
    return false;
  }
  switch (operator) {
    case "lt":
      return actual < value;
    case "lte":
      return actual <= value;
    case "gt":
      return actual > value;
    case "gte":
      return actual >= value;
    default:
      return false;
  }
}

/** Test one Rule against one Game; `false` for every missing value. */
export function testRule(rule: Rule, game: RuleTarget): boolean {
  const definition = ruleFieldDefinition(rule.field);
  if (definition === undefined) {
    return false;
  }

  if (rule.field === "game") {
    return Array.isArray(rule.value) && rule.value.includes(game.appId);
  }

  if (isListField(definition)) {
    if (rule.operator !== "has" || typeof rule.value !== "string") {
      return false;
    }
    const elements = readList(rule.field, game);
    if (elements.length === 0) {
      return false;
    }
    if (rule.field === "steamCollection") {
      return elements.includes(rule.value);
    }
    const expected = normalizeRuleText(rule.value);
    return elements.some((element) => normalizeRuleText(element) === expected);
  }

  const actual = readSingle(rule.field, game);
  if (actual === null) {
    return false;
  }

  switch (rule.operator) {
    case "is":
      if (typeof actual === "boolean") {
        return actual === rule.value;
      }
      return (
        typeof actual === "string" &&
        typeof rule.value === "string" &&
        normalizeRuleText(actual) === normalizeRuleText(rule.value)
      );
    case "contains":
      return (
        typeof actual === "string" &&
        typeof rule.value === "string" &&
        normalizeRuleText(actual).includes(normalizeRuleText(rule.value))
      );
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      if (typeof actual !== "number") {
        return false;
      }
      if (definition.valueKind === "date") {
        return (
          typeof rule.value === "string" &&
          compareNumbers(actual, dateOrdinal(rule.value), rule.operator)
        );
      }
      return compareNumbers(actual, rule.value, rule.operator);
    default:
      return false;
  }
}

/** The documented global grouping: every AND, at least one OR, no NOT. */
export function gameMatchesRules(rules: readonly Rule[], game: RuleTarget): boolean {
  for (const rule of rules) {
    if (rule.prefix === "AND" && !testRule(rule, game)) {
      return false;
    }
  }

  let hasOr = false;
  let orMatched = false;
  for (const rule of rules) {
    if (rule.prefix === "OR") {
      hasOr = true;
      if (!orMatched && testRule(rule, game)) {
        orMatched = true;
      }
    }
  }
  if (hasOr && !orMatched) {
    return false;
  }

  for (const rule of rules) {
    if (rule.prefix === "NOT" && testRule(rule, game)) {
      return false;
    }
  }

  return true;
}

/** Match a whole Library and return ascending App IDs. */
export function evaluateRuleIds(rules: readonly Rule[], games: readonly RuleTarget[]): number[] {
  return games
    .filter((game) => gameMatchesRules(rules, game))
    .map((game) => game.appId)
    .sort((left, right) => left - right);
}
