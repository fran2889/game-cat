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

type RulePredicate = (game: RuleTarget) => boolean;

/**
 * Per-evaluation normalized views of a Game's list fields. Arrays are stable
 * per Game, so compiling the normalized set once per Game and per evaluation
 * avoids normalizing every Tag for every Rule.
 */
interface ListCaches {
  normalized: WeakMap<readonly string[], ReadonlySet<string>>;
  raw: WeakMap<readonly string[], ReadonlySet<string>>;
}

function normalizedSet(elements: readonly string[], caches: ListCaches): ReadonlySet<string> {
  const cached = caches.normalized.get(elements);
  if (cached !== undefined) {
    return cached;
  }
  const set = new Set<string>();
  for (const element of elements) {
    set.add(normalizeRuleText(element));
  }
  caches.normalized.set(elements, set);
  return set;
}

function rawSet(elements: readonly string[], caches: ListCaches): ReadonlySet<string> {
  const cached = caches.raw.get(elements);
  if (cached !== undefined) {
    return cached;
  }
  const set = new Set(elements);
  caches.raw.set(elements, set);
  return set;
}

/**
 * Compile one Rule into a predicate. All Rule-value normalization, date
 * parsing, and App ID list construction happen here, once per evaluation,
 * instead of once per Game. The behavior is exactly `testRule` (§5.5.2).
 */
function compileRule(rule: Rule, caches: ListCaches): RulePredicate {
  const definition = ruleFieldDefinition(rule.field);
  if (definition === undefined) {
    return () => false;
  }

  if (rule.field === "game") {
    if (!Array.isArray(rule.value)) {
      return () => false;
    }
    const appIds = new Set(rule.value);
    return (game) => appIds.has(game.appId);
  }

  if (isListField(definition)) {
    if (rule.operator !== "has" || typeof rule.value !== "string") {
      return () => false;
    }
    const field = rule.field;
    const value = rule.value;
    if (field === "steamCollection") {
      return (game) => {
        const elements = readList(field, game);
        return elements.length > 0 && rawSet(elements, caches).has(value);
      };
    }
    const expected = normalizeRuleText(value);
    return (game) => {
      const elements = readList(field, game);
      return elements.length > 0 && normalizedSet(elements, caches).has(expected);
    };
  }

  const field = rule.field;
  const actualOf = (game: RuleTarget): SingleValue => readSingle(field, game);

  switch (rule.operator) {
    case "is": {
      const value = rule.value;
      if (typeof value === "boolean") {
        return (game) => actualOf(game) === value;
      }
      if (typeof value !== "string") {
        return () => false;
      }
      const expected = normalizeRuleText(value);
      return (game) => {
        const actual = actualOf(game);
        return typeof actual === "string" && normalizeRuleText(actual) === expected;
      };
    }
    case "contains": {
      if (typeof rule.value !== "string") {
        return () => false;
      }
      const expected = normalizeRuleText(rule.value);
      return (game) => {
        const actual = actualOf(game);
        return typeof actual === "string" && normalizeRuleText(actual).includes(expected);
      };
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const operator = rule.operator;
      const value =
        definition.valueKind === "date"
          ? typeof rule.value === "string"
            ? dateOrdinal(rule.value)
            : Number.NaN
          : typeof rule.value === "number"
            ? rule.value
            : Number.NaN;
      return (game) => {
        const actual = actualOf(game);
        return typeof actual === "number" && compareNumbers(actual, value, operator);
      };
    }
    default:
      return () => false;
  }
}

export interface CompiledRules {
  matches(game: RuleTarget): boolean;
}

/**
 * Compile a whole Rules array once. The global grouping is unchanged: every
 * AND, at least one OR, and no NOT (§5.5.2).
 */
export function compileRules(rules: readonly Rule[]): CompiledRules {
  const caches: ListCaches = { normalized: new WeakMap(), raw: new WeakMap() };
  const andRules: RulePredicate[] = [];
  const orRules: RulePredicate[] = [];
  const notRules: RulePredicate[] = [];
  for (const rule of rules) {
    const predicate = compileRule(rule, caches);
    if (rule.prefix === "AND") {
      andRules.push(predicate);
    } else if (rule.prefix === "OR") {
      orRules.push(predicate);
    } else if (rule.prefix === "NOT") {
      notRules.push(predicate);
    }
  }

  return {
    matches(game) {
      for (const predicate of andRules) {
        if (!predicate(game)) {
          return false;
        }
      }
      if (orRules.length > 0) {
        let matched = false;
        for (const predicate of orRules) {
          if (predicate(game)) {
            matched = true;
            break;
          }
        }
        if (!matched) {
          return false;
        }
      }
      for (const predicate of notRules) {
        if (predicate(game)) {
          return false;
        }
      }
      return true;
    },
  };
}

/**
 * Test one Rule's condition against one Game, ignoring its Prefix; `false` for
 * every missing value. `gameMatchesRules` applies the Prefix grouping.
 */
export function testRule(rule: Rule, game: RuleTarget): boolean {
  const caches: ListCaches = { normalized: new WeakMap(), raw: new WeakMap() };
  return compileRule(rule, caches)(game);
}

/** The documented global grouping: every AND, at least one OR, no NOT. */
export function gameMatchesRules(rules: readonly Rule[], game: RuleTarget): boolean {
  return compileRules(rules).matches(game);
}

/** Match a whole Library and return ascending App IDs. */
export function evaluateRuleIds(rules: readonly Rule[], games: readonly RuleTarget[]): number[] {
  const compiled = compileRules(rules);
  const matched: number[] = [];
  for (const game of games) {
    if (compiled.matches(game)) {
      matched.push(game.appId);
    }
  }
  return matched.sort((left, right) => left - right);
}
