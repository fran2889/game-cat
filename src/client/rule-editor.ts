import {
  MAX_GAME_RULE_IDS,
  RULE_PREFIXES,
  collectionNameProblem,
  ruleFieldDefinition,
  type Rule,
  type RuleField,
  type RuleOperator,
  type RulePrefix,
  type RuleValue,
} from "../shared/rules.ts";

/**
 * Client-side Rule editor helpers.
 *
 * These are deliberately pure: they build and edit draft Rules, apply the
 * editor's typed defaults, and validate the collection name. The shared
 * validator remains the only owner of Rule validity.
 */

export function defaultValueForField(field: RuleField): RuleValue {
  const definition = ruleFieldDefinition(field);
  switch (definition?.valueKind) {
    case "boolean":
      return true;
    case "integer":
      return 0;
    case "enum":
      return definition.values?.[0] ?? "";
    case "appIds":
      return [];
    case "date":
    case "steamCollection":
    case "text":
    case "openEnum":
    case "multiText":
    default:
      return "";
  }
}

export function emptyRule(field: RuleField = "tag"): Rule {
  const definition = ruleFieldDefinition(field);
  const operator = definition?.operators[0] ?? "has";
  return { prefix: "AND", field, operator, value: defaultValueForField(field) };
}

export function changeRuleField(rule: Rule, field: RuleField): Rule {
  const definition = ruleFieldDefinition(field);
  if (definition === undefined) {
    return rule;
  }
  const operator = definition.operators.includes(rule.operator)
    ? rule.operator
    : definition.operators[0]!;
  return { ...rule, field, operator, value: defaultValueForField(field) };
}

export function allowedOperators(field: RuleField): readonly RuleOperator[] {
  return ruleFieldDefinition(field)?.operators ?? [];
}

export function changeRuleOperator(rule: Rule, operator: RuleOperator): Rule {
  return allowedOperators(rule.field).includes(operator) ? { ...rule, operator } : rule;
}

export function changeRulePrefix(rule: Rule, prefix: RulePrefix): Rule {
  return RULE_PREFIXES.includes(prefix) ? { ...rule, prefix } : rule;
}

/** Dropdown labels and sentence fallbacks share one Operator vocabulary. */
export const RULE_OPERATOR_LABELS: Record<RuleOperator, string> = {
  is: "is",
  contains: "contains",
  has: "has",
  in: "is one of",
  lt: "is less than",
  lte: "is at most",
  gt: "is greater than",
  gte: "is at least",
};

const COMPARISON_SYMBOLS: Partial<Record<RuleOperator, string>> = {
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
};

function humanizeRuleValue(value: string): string {
  const words = value.split(/[_\s]+/).filter((word) => word !== "");
  if (words.length === 0) {
    return value;
  }
  const sentence = words.join(" ").toLowerCase();
  return sentence[0]!.toUpperCase() + sentence.slice(1);
}

export interface RuleDescriptionOptions {
  /** Resolve a Steam Collection id to its mirrored name for the row copy. */
  collectionName?(id: string): string | undefined;
}

/**
 * A short, human-readable summary of one Rule, built from the Field registry
 * in `shared/rules.ts`. Fields without a specific phrasing fall back to
 * `<Label> <operator>…`, so a draft row is never blank.
 */
export function describeRule(rule: Rule, options: RuleDescriptionOptions = {}): string {
  const definition = ruleFieldDefinition(rule.field);
  if (definition === undefined) {
    return "Rule";
  }
  const fallback = `${definition.label} ${RULE_OPERATOR_LABELS[rule.operator]}…`;
  const value = rule.value;
  const hasText = typeof value === "string" && value.trim() !== "";
  const hasNumber = typeof value === "number" && Number.isFinite(value) && value >= 0;
  const comparison = COMPARISON_SYMBOLS[rule.operator];

  switch (definition.valueKind) {
    case "boolean":
      if (typeof value !== "boolean") {
        return fallback;
      }
      if (rule.field === "installed") {
        return value ? "Installed" : "Not installed";
      }
      return `${definition.label}: ${value ? "true" : "false"}`;

    case "appIds":
      if (!Array.isArray(value) || value.length === 0) {
        return fallback;
      }
      return `${definition.label}: ${value.length} ${value.length === 1 ? "game" : "games"}`;

    case "steamCollection": {
      if (!hasText) {
        return fallback;
      }
      const id = value as string;
      return `${definition.label}: ${options.collectionName?.(id) ?? id}`;
    }

    case "date":
      if (!hasText || comparison === undefined) {
        return fallback;
      }
      return `${definition.label} ${comparison} ${value as string}`;

    case "integer":
      if (!hasNumber || comparison === undefined) {
        return fallback;
      }
      if (rule.field === "playtime") {
        return `${definition.label} ${comparison} ${formatMinutesAsHours(value as number)} h`;
      }
      return `${definition.label} ${comparison} ${value as number}`;

    case "enum":
      if (!hasText) {
        return fallback;
      }
      return `${definition.label}: ${humanizeRuleValue(value as string)}`;

    case "text":
      if (!hasText) {
        return fallback;
      }
      if (rule.field === "name") {
        return rule.operator === "is"
          ? `Named "${value as string}"`
          : `Name contains "${value as string}"`;
      }
      return `${definition.label} ${RULE_OPERATOR_LABELS[rule.operator]} "${value as string}"`;

    case "multiText":
      if (!hasText) {
        return fallback;
      }
      if (rule.field === "tag") {
        return `Tagged "${value as string}"`;
      }
      return `${definition.label}: ${value as string}`;

    case "openEnum":
      if (!hasText) {
        return fallback;
      }
      return `${definition.label} ${RULE_OPERATOR_LABELS[rule.operator]} "${value as string}"`;
  }
}

export interface PrefixCounts {
  AND: number;
  OR: number;
  NOT: number;
}

export function prefixCounts(rules: readonly Rule[]): PrefixCounts {
  const counts: PrefixCounts = { AND: 0, OR: 0, NOT: 0 };
  for (const rule of rules) {
    counts[rule.prefix] += 1;
  }
  return counts;
}

export function validateCollectionName(name: string): string | null {
  switch (collectionNameProblem(name)) {
    case "control":
      return "The name must not contain control characters.";
    case "empty":
      return "Enter a name between 1 and 80 characters.";
    case "too-long":
      return "The name must be 80 characters or fewer.";
    case null:
      return null;
  }
}

/** Parse an hours input into integer minutes; `null` means invalid. */
export function parseHoursToMinutes(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const hours = Number.parseFloat(trimmed);
  const minutes = Math.round(hours * 60);
  return Number.isSafeInteger(minutes) && minutes >= 0 ? minutes : null;
}

export function formatMinutesAsHours(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) {
    return "";
  }
  return Number((minutes / 60).toFixed(2)).toString();
}

/** One `AND platform has <name>` Rule per selected platform. */
export function platformsInRules(rules: readonly Rule[]): string[] {
  return rules
    .filter(
      (rule) =>
        rule.prefix === "AND" &&
        rule.field === "platform" &&
        rule.operator === "has" &&
        typeof rule.value === "string",
    )
    .map((rule) => rule.value as string);
}

export function togglePlatformRule(rules: readonly Rule[], platform: string): Rule[] {
  const existing = platformsInRules(rules);
  if (existing.includes(platform)) {
    return rules.filter(
      (rule) =>
        !(
          rule.prefix === "AND" &&
          rule.field === "platform" &&
          rule.operator === "has" &&
          rule.value === platform
        ),
    );
  }
  return [...rules, { prefix: "AND", field: "platform", operator: "has", value: platform }];
}

export function gameRuleIds(rule: Rule): number[] {
  return rule.field === "game" && Array.isArray(rule.value) ? [...rule.value] : [];
}

/** Sorted, unique App IDs for a Game list Rule; empty input stays invalid. */
export function sortedGameIds(appIds: Iterable<number>): number[] {
  const unique = new Set<number>();
  for (const appId of appIds) {
    if (Number.isSafeInteger(appId) && appId > 0) {
      unique.add(appId);
    }
  }
  return [...unique].sort((left, right) => left - right);
}

function gameRuleIndex(rules: readonly Rule[]): number {
  return rules.findIndex((rule) => rule.field === "game");
}

/** The App IDs that the `game` Rule would contain after adding a selection. */
export function mergedGameRuleIds(rules: readonly Rule[], appIds: Iterable<number>): number[] {
  const index = gameRuleIndex(rules);
  const existing =
    index === -1 || !Array.isArray(rules[index]!.value) ? [] : (rules[index]!.value as number[]);
  return sortedGameIds([...existing, ...appIds]);
}

/**
 * Add selected Games to the one `game` Rule, or create it, without producing a
 * second `game` Rule. Returns `null` when the result would exceed 1,000 IDs.
 */
export function addSelectionToGameRule(
  rules: readonly Rule[],
  appIds: Iterable<number>,
): Rule[] | null {
  const index = gameRuleIndex(rules);
  const merged = mergedGameRuleIds(rules, appIds);
  if (merged.length === 0 || merged.length > MAX_GAME_RULE_IDS) {
    return null;
  }
  if (index === -1) {
    return [...rules, { prefix: "AND", field: "game", operator: "in", value: merged }];
  }
  return rules.map((rule, position) => (position === index ? { ...rule, value: merged } : rule));
}
