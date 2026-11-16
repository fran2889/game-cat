import type BetterSqlite3 from "better-sqlite3";
import { normalizeNameKey } from "../../shared/names.ts";
import type {
  Pagination,
  RuleValue,
  RuleValueField,
  RuleValuesResponse,
} from "../../shared/types.ts";
import { parseInteger, validationError, type RawQuery } from "../request.ts";

/**
 * The read-time picker for Rule values (spec §4.3, §3.5).
 *
 * Values come from the four storefront JSON arrays. Nothing is materialized:
 * distinct values, the display spelling, and the distinct-Game count are all
 * computed here, so no new table or write path is needed.
 */

export const RULE_VALUE_FIELDS: readonly RuleValueField[] = [
  "genre",
  "category",
  "developer",
  "publisher",
];

const FIELD_COLUMNS: Record<RuleValueField, string> = {
  genre: "genres_json",
  category: "categories_json",
  developer: "developers_json",
  publisher: "publishers_json",
};

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 80;

export interface RuleValuesQuery {
  field: RuleValueField;
  query: string | null;
  page: number;
  pageSize: number;
}

export function parseRuleValuesQuery(raw: RawQuery): RuleValuesQuery {
  const fieldErrors: Record<string, string> = {};

  let field: RuleValueField = "genre";
  if (raw.field === undefined || raw.field === "") {
    fieldErrors.field = "is required";
  } else if (!(RULE_VALUE_FIELDS as readonly string[]).includes(raw.field)) {
    fieldErrors.field = `must be one of ${RULE_VALUE_FIELDS.join(", ")}`;
  } else {
    field = raw.field as RuleValueField;
  }

  let query: string | null = null;
  if (raw.query !== undefined && raw.query.trim() !== "") {
    if (raw.query.length > MAX_QUERY_LENGTH) {
      fieldErrors.query = `must be at most ${MAX_QUERY_LENGTH} characters`;
    } else {
      query = normalizeNameKey(raw.query);
    }
  }

  const page = parseInteger(raw.page, 1, "page", 1, Number.MAX_SAFE_INTEGER, fieldErrors);
  const pageSize = parseInteger(
    raw.pageSize,
    DEFAULT_PAGE_SIZE,
    "pageSize",
    1,
    MAX_PAGE_SIZE,
    fieldErrors,
  );

  if (Object.keys(fieldErrors).length > 0) {
    throw validationError(fieldErrors);
  }

  return { field, query, page, pageSize };
}

interface ValueAccumulator {
  display: string;
  key: string;
  appIds: Set<number>;
}

interface ValueRow {
  app_id: number;
  value_json: string;
}

function readValues(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
    );
  } catch {
    return [];
  }
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class RuleValuesRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(query: RuleValuesQuery): RuleValuesResponse {
    const column = FIELD_COLUMNS[query.field];
    const rows = this.db
      .prepare(
        `SELECT sf.app_id AS app_id, sf.${column} AS value_json
         FROM storefront_appdetails sf
         JOIN games g ON g.app_id = sf.app_id`,
      )
      .all() as ValueRow[];

    const values = new Map<string, ValueAccumulator>();
    for (const row of rows) {
      const seenInGame = new Set<string>();
      for (const raw of readValues(row.value_json)) {
        const value = raw.trim();
        const key = normalizeNameKey(value);
        if (query.query !== null && !key.includes(query.query)) {
          continue;
        }
        if (seenInGame.has(key)) {
          continue;
        }
        seenInGame.add(key);
        const existing = values.get(key);
        if (existing === undefined) {
          values.set(key, { display: value, key, appIds: new Set([row.app_id]) });
        } else {
          existing.appIds.add(row.app_id);
          if (value < existing.display) {
            existing.display = value;
          }
        }
      }
    }

    const ordered: Array<{ value: string; key: string; gameCount: number }> = [...values.values()]
      .map((entry) => ({
        value: entry.display,
        key: entry.key,
        gameCount: entry.appIds.size,
      }))
      .filter((entry) => entry.gameCount > 0)
      .sort((left, right) => right.gameCount - left.gameCount || compareKeys(left.key, right.key));

    const totalItems = ordered.length;
    const offset = (query.page - 1) * query.pageSize;
    const pageValues: RuleValue[] = ordered
      .slice(offset, offset + query.pageSize)
      .map((entry) => ({ value: entry.value, gameCount: entry.gameCount }));

    const pagination: Pagination = {
      page: query.page,
      pageSize: query.pageSize,
      totalItems,
      totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / query.pageSize),
    };

    return { data: pageValues, pagination };
  }
}
