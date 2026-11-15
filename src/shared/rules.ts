/**
 * The Rule grammar shared by the server and the Rule editor (spec §5).
 *
 * The Field registry is the single source of truth for a Field's value type,
 * its allowed Operators, where its value comes from, and how a missing value
 * behaves. The validator is shared so preview, persistence, and the editor
 * reject exactly the same Rules.
 */

import { normalizeNameKey } from "./names.ts";
import { GAME_SORTS, type GameOrder, type GameSort } from "./types.ts";

export const RULE_PREFIXES = ["AND", "OR", "NOT"] as const;
export type RulePrefix = (typeof RULE_PREFIXES)[number];

export const RULE_OPERATORS = ["is", "contains", "has", "in", "lt", "lte", "gt", "gte"] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const RULE_FIELDS = [
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
] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

export type RuleValue = string | number | boolean | number[];

export interface Rule {
  prefix: RulePrefix;
  field: RuleField;
  operator: RuleOperator;
  value: RuleValue;
}

export type RuleValueKind =
  | "text"
  | "openEnum"
  | "boolean"
  | "enum"
  | "integer"
  | "date"
  | "multiText"
  | "steamCollection"
  | "appIds";

export interface RuleFieldDefinition {
  field: RuleField;
  label: string;
  valueKind: RuleValueKind;
  operators: readonly RuleOperator[];
  /** The storage source named by the spec registry. */
  source: string;
  /** What a missing value means for positive matching. */
  missing: string;
  /** The closed value set for `enum` Fields. */
  values?: readonly string[];
  min?: number;
  max?: number;
}

const TEXT_MISSING = "never missing";
const METADATA_MISSING = "null means unknown";

export const RULE_FIELD_DEFINITIONS: readonly RuleFieldDefinition[] = [
  {
    field: "name",
    label: "Name",
    valueKind: "text",
    operators: ["is", "contains"],
    source: "games.name",
    missing: TEXT_MISSING,
  },
  {
    field: "playtime",
    label: "Playtime",
    valueKind: "integer",
    operators: ["lt", "lte", "gt", "gte"],
    source: "games.playtime_minutes",
    missing: "never missing; 0 is a real value",
    min: 0,
  },
  {
    field: "installed",
    label: "Installed",
    valueKind: "boolean",
    operators: ["is"],
    source: "games.installed",
    missing: "null means unknown",
  },
  {
    field: "ownershipStatus",
    label: "Ownership",
    valueKind: "enum",
    operators: ["is"],
    source: "games.ownership_status",
    missing: TEXT_MISSING,
    values: ["owned", "local_only", "unknown"],
  },
  {
    field: "lastPlayed",
    label: "Last played",
    valueKind: "date",
    operators: ["lt", "lte", "gt", "gte"],
    source: "v_games.last_played_at",
    missing: "null means never or unknown",
  },
  {
    field: "releaseYear",
    label: "Release year",
    valueKind: "integer",
    operators: ["lt", "lte", "gt", "gte"],
    source: "storefront_appdetails.release_year",
    missing: METADATA_MISSING,
    min: 1000,
    max: 9999,
  },
  {
    field: "metacriticScore",
    label: "Metacritic score",
    valueKind: "integer",
    operators: ["lt", "lte", "gt", "gte"],
    source: "storefront_appdetails.metacritic_score",
    missing: METADATA_MISSING,
    min: 0,
    max: 100,
  },
  {
    field: "reviewScore",
    label: "Review score",
    valueKind: "integer",
    operators: ["lt", "lte", "gt", "gte"],
    source: "steam_review_summaries counts, computed",
    missing: "null means no usable review summary",
    min: 0,
    max: 100,
  },
  {
    field: "reviewTier",
    label: "Review tier",
    valueKind: "openEnum",
    operators: ["is"],
    source: "steam_review_summaries.review_tier",
    missing: "null means no usable review summary",
  },
  {
    field: "reviewCount",
    label: "Review count",
    valueKind: "integer",
    operators: ["lt", "lte", "gt", "gte"],
    source: "steam_review_summaries.review_total",
    missing: "null means unknown; 0 is known",
    min: 0,
  },
  {
    field: "storefrontType",
    label: "Storefront type",
    valueKind: "openEnum",
    operators: ["is"],
    source: "storefront_appdetails.type",
    missing: METADATA_MISSING,
  },
  {
    field: "platform",
    label: "Platform",
    valueKind: "enum",
    operators: ["has"],
    source: "storefront_appdetails.platforms_json",
    missing: "empty set when unknown",
    values: ["windows", "mac", "linux"],
  },
  {
    field: "genre",
    label: "Genre",
    valueKind: "multiText",
    operators: ["has"],
    source: "storefront_appdetails.genres_json",
    missing: "empty set when unknown",
  },
  {
    field: "category",
    label: "Storefront category",
    valueKind: "multiText",
    operators: ["has"],
    source: "storefront_appdetails.categories_json",
    missing: "empty set when unknown",
  },
  {
    field: "developer",
    label: "Developer",
    valueKind: "multiText",
    operators: ["has"],
    source: "storefront_appdetails.developers_json",
    missing: "empty set when unknown",
  },
  {
    field: "publisher",
    label: "Publisher",
    valueKind: "multiText",
    operators: ["has"],
    source: "storefront_appdetails.publishers_json",
    missing: "empty set when unknown",
  },
  {
    field: "tag",
    label: "Tag",
    valueKind: "multiText",
    operators: ["has"],
    source: "tags, game_tags",
    missing: "empty set when unknown",
  },
  {
    field: "steamCollection",
    label: "Steam collection",
    valueKind: "steamCollection",
    operators: ["has"],
    source: "steam_collections, steam_collection_games",
    missing: "empty set when unknown",
  },
  {
    field: "game",
    label: "Game list",
    valueKind: "appIds",
    operators: ["in"],
    source: "games.app_id",
    missing: TEXT_MISSING,
  },
];

const FIELD_INDEX = new Map<string, RuleFieldDefinition>(
  RULE_FIELD_DEFINITIONS.map((definition) => [definition.field, definition]),
);

export function ruleFieldDefinition(field: string): RuleFieldDefinition | undefined {
  return FIELD_INDEX.get(field);
}

export function isRulePrefix(value: unknown): value is RulePrefix {
  return typeof value === "string" && (RULE_PREFIXES as readonly string[]).includes(value);
}

export function isRuleOperator(value: unknown): value is RuleOperator {
  return typeof value === "string" && (RULE_OPERATORS as readonly string[]).includes(value);
}

export const MAX_RULES = 100;
export const MAX_RULE_VALUE_BYTES = 16 * 1024;
export const MAX_RULE_TEXT_CODE_POINTS = 200;
export const MAX_STEAM_COLLECTION_ID_LENGTH = 128;
export const MAX_GAME_RULE_IDS = 1_000;
export const MAX_RULE_NAME_CODE_POINTS = 80;

export const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Rule text uses the same normalization as every name key (§2.7); the alias
 * keeps Rule-facing call sites readable.
 */
export const normalizeRuleText = normalizeNameKey;

export function codePointLength(value: string): number {
  return [...value].length;
}

function encodedByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Days since 1970-01-01 for a validated `YYYY-MM-DD` value. */
export function dateOrdinal(value: string): number {
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  return Math.floor(Date.UTC(year!, month! - 1, day!) / 86_400_000);
}

/** Days since 1970-01-01 for a UTC Unix-seconds timestamp. */
export function timestampDateOrdinal(seconds: number): number {
  return Math.floor(seconds / 86_400);
}

function validateTextValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return "must be a string";
  }
  if (CONTROL_CHARACTERS.test(value)) {
    return "must not contain control characters";
  }
  const normalized = normalizeRuleText(value);
  if (normalized === "") {
    return "must not be empty";
  }
  if (codePointLength(normalized) > MAX_RULE_TEXT_CODE_POINTS) {
    return `must be at most ${MAX_RULE_TEXT_CODE_POINTS} characters`;
  }
  return null;
}

function validateIntegerValue(value: unknown, definition: RuleFieldDefinition): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return "must be an integer";
  }
  if (definition.min !== undefined && value < definition.min) {
    return `must be at least ${definition.min}`;
  }
  if (definition.max !== undefined && value > definition.max) {
    return `must be at most ${definition.max}`;
  }
  return null;
}

function validateAppIds(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return "must be an array of App IDs";
  }
  if (value.length < 1) {
    return "must contain at least one App ID";
  }
  if (value.length > MAX_GAME_RULE_IDS) {
    return `must contain at most ${MAX_GAME_RULE_IDS} App IDs`;
  }
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      return "must contain positive integer App IDs";
    }
    if (seen.has(entry)) {
      return "must not contain duplicate App IDs";
    }
    seen.add(entry);
  }
  return null;
}

/** Validate one Field's Value. Returns a message, or `null` when valid. */
export function validateRuleValue(definition: RuleFieldDefinition, value: unknown): string | null {
  switch (definition.valueKind) {
    case "text":
    case "openEnum":
    case "multiText":
      return validateTextValue(value);
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "integer":
      return validateIntegerValue(value, definition);
    case "enum": {
      if (typeof value !== "string") {
        return "must be a string";
      }
      const normalized = normalizeRuleText(value);
      return (definition.values ?? []).includes(normalized)
        ? null
        : `must be one of ${(definition.values ?? []).join(", ")}`;
    }
    case "date":
      return typeof value === "string" && isRealDate(value)
        ? null
        : "must be a real YYYY-MM-DD date";
    case "steamCollection":
      return typeof value !== "string"
        ? "must be a string"
        : codePointLength(value) < 1 || codePointLength(value) > MAX_STEAM_COLLECTION_ID_LENGTH
          ? `must be 1-${MAX_STEAM_COLLECTION_ID_LENGTH} characters`
          : null;
    case "appIds":
      return validateAppIds(value);
  }
}

export interface RuleValidationResult {
  rules: Rule[];
  fieldErrors: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Validate the full Rules array and return the typed Rules plus dotted errors. */
export function validateRules(input: unknown): RuleValidationResult {
  const fieldErrors: Record<string, string> = {};
  const rules: Rule[] = [];
  if (input === undefined) {
    return { rules, fieldErrors };
  }
  if (!Array.isArray(input)) {
    fieldErrors.rules = "must be an array";
    return { rules, fieldErrors };
  }
  if (input.length > MAX_RULES) {
    fieldErrors.rules = `must contain at most ${MAX_RULES} rules`;
    return { rules, fieldErrors };
  }

  input.forEach((entry, index) => {
    const path = `rules.${index}`;
    const candidate = asRecord(entry);
    if (candidate === null) {
      fieldErrors[path] = "must be an object";
      return;
    }

    const prefix = candidate.prefix;
    const field = candidate.field;
    const operator = candidate.operator;
    const value = candidate.value;

    if (!isRulePrefix(prefix)) {
      fieldErrors[`${path}.prefix`] = `must be one of ${RULE_PREFIXES.join(", ")}`;
    }

    const definition = typeof field === "string" ? ruleFieldDefinition(field) : undefined;
    if (definition === undefined) {
      fieldErrors[`${path}.field`] = `must be one of ${RULE_FIELDS.join(", ")}`;
    }

    if (!isRuleOperator(operator)) {
      fieldErrors[`${path}.operator`] = `must be one of ${RULE_OPERATORS.join(", ")}`;
    } else if (definition !== undefined && !definition.operators.includes(operator)) {
      fieldErrors[`${path}.operator`] =
        `${definition.field} accepts ${definition.operators.join(", ")}`;
    }

    if (definition !== undefined) {
      const valueError = validateRuleValue(definition, value);
      if (valueError !== null) {
        fieldErrors[`${path}.value`] = valueError;
      } else {
        let serialized: string;
        try {
          serialized = JSON.stringify(value);
        } catch {
          serialized = "";
        }
        if (encodedByteLength(serialized) > MAX_RULE_VALUE_BYTES) {
          fieldErrors[`${path}.value`] =
            `must serialize to at most ${MAX_RULE_VALUE_BYTES / 1024} KiB`;
        }
      }
    }

    if (
      definition !== undefined &&
      isRulePrefix(prefix) &&
      isRuleOperator(operator) &&
      definition.operators.includes(operator)
    ) {
      rules.push({ prefix, field: definition.field, operator, value: value as RuleValue });
    }
  });

  return { rules, fieldErrors };
}

export interface RulesPreviewRequest {
  rules: Rule[];
  page: number;
  pageSize: number;
  sort: GameSort;
  order: GameOrder;
}

export interface RulesPreviewValidation extends RulesPreviewRequest {
  fieldErrors: Record<string, string>;
}

function previewInteger(
  value: unknown,
  fallback: number,
  field: string,
  min: number,
  max: number,
  fieldErrors: Record<string, string>,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fieldErrors[field] = `must be an integer between ${min} and ${max}`;
    return fallback;
  }
  return value;
}

/** Validate `POST /api/rules/preview` and return defaults for omitted paging. */
export function validatePreviewRequest(input: unknown): RulesPreviewValidation {
  const candidate = asRecord(input) ?? {};
  const rules = validateRules(candidate.rules);
  const fieldErrors: Record<string, string> = { ...rules.fieldErrors };

  const page = previewInteger(candidate.page, 1, "page", 1, Number.MAX_SAFE_INTEGER, fieldErrors);
  const pageSize = previewInteger(candidate.pageSize, 60, "pageSize", 1, 200, fieldErrors);

  const sort = candidate.sort ?? "name";
  if (typeof sort !== "string" || !(GAME_SORTS as readonly string[]).includes(sort)) {
    fieldErrors.sort = `must be one of ${GAME_SORTS.join(", ")}`;
  }
  const order = candidate.order ?? "asc";
  if (order !== "asc" && order !== "desc") {
    fieldErrors.order = "must be asc or desc";
  }

  return {
    rules: rules.rules,
    page,
    pageSize,
    sort: (sort as GameSort) ?? "name",
    order: (order as GameOrder) ?? "asc",
    fieldErrors,
  };
}
