import {
  CONTROL_CHARACTERS,
  MAX_GAME_RULE_IDS,
  codePointLength,
  RULE_PREFIXES,
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
 * These are deliberately pure: they build and edit draft Rules, mirror the
 * Field registry's Operator/value types, and validate the collection name. The
 * shared validator decides whether a draft can be previewed.
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
  if (CONTROL_CHARACTERS.test(name)) {
    return "The name must not contain control characters.";
  }
  const length = codePointLength(name.trim().normalize("NFC"));
  if (length < 1) {
    return "Enter a name between 1 and 80 characters.";
  }
  if (length > 80) {
    return "The name must be 80 characters or fewer.";
  }
  return null;
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
