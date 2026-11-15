/**
 * Router-state handoff for "New from selection" (§7.3, §7.4).
 *
 * #31/#32 consume the same shape when they build the Smart Collection editor;
 * keeping it here makes the handoff testable without the editor.
 */

export type RulePrefix = "AND" | "OR" | "NOT";

export interface RuleDraft {
  prefix: RulePrefix;
  field: string;
  operator: string;
  value: unknown;
}

export interface SmartCollectionDraftHandoff {
  name: string;
  sourceAppIds: number[];
  rules: RuleDraft[];
}

export const SMART_COLLECTION_DRAFT_STATE = "smartCollectionDraft";
export const NEW_COLLECTION_NAME = "New Smart Collection";

export function sortedSelection(appIds: Iterable<number>): number[] {
  const unique = new Set<number>();
  for (const appId of appIds) {
    if (Number.isSafeInteger(appId) && appId > 0) {
      unique.add(appId);
    }
  }
  return [...unique].sort((left, right) => left - right);
}

/** One `AND game in [...]` Rule with ascending App IDs, as §7.4 requires. */
export function handoffFromSelection(appIds: Iterable<number>): SmartCollectionDraftHandoff {
  const sourceAppIds = sortedSelection(appIds);
  return {
    name: NEW_COLLECTION_NAME,
    sourceAppIds,
    rules: [{ prefix: "AND", field: "game", operator: "in", value: sourceAppIds }],
  };
}

function isRuleDraft(value: unknown): value is RuleDraft {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const rule = value as Record<string, unknown>;
  return (
    (rule.prefix === "AND" || rule.prefix === "OR" || rule.prefix === "NOT") &&
    typeof rule.field === "string" &&
    typeof rule.operator === "string" &&
    "value" in rule
  );
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => Number.isSafeInteger(entry));
}

export function readDraftHandoff(state: unknown): SmartCollectionDraftHandoff | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const candidate = (state as Record<string, unknown>)[SMART_COLLECTION_DRAFT_STATE];
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const handoff = candidate as Record<string, unknown>;
  if (
    typeof handoff.name !== "string" ||
    !isNumberArray(handoff.sourceAppIds) ||
    !Array.isArray(handoff.rules) ||
    !handoff.rules.every(isRuleDraft)
  ) {
    return null;
  }
  const sourceAppIds = handoff.sourceAppIds;
  const rules = handoff.rules;
  const gameRule = rules[0];
  if (
    rules.length !== 1 ||
    gameRule === undefined ||
    gameRule.prefix !== "AND" ||
    gameRule.field !== "game" ||
    gameRule.operator !== "in" ||
    !isNumberArray(gameRule.value) ||
    gameRule.value.length !== sourceAppIds.length ||
    gameRule.value.some((appId, index) => appId !== sourceAppIds[index])
  ) {
    return null;
  }
  return {
    name: handoff.name,
    sourceAppIds,
    rules,
  };
}
