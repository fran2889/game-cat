import type BetterSqlite3 from "better-sqlite3";
import { sql } from "kysely";
import { normalizeNameKey } from "../../shared/names.ts";
import { RULE_VALUE_FIELDS } from "../../shared/rules.ts";
import { allSync, queryFor } from "../db/query.ts";
import type {
  Pagination,
  RuleValue,
  RuleValueField,
  RuleValuesResponse,
} from "../../shared/types.ts";

/**
 * The read-time picker for Rule values (spec §4.3, §3.5).
 *
 * Values come from the four storefront JSON arrays. Nothing is materialized:
 * distinct values, the display spelling, and the distinct-Game count are all
 * computed here, so no new table or write path is needed.
 */

const FIELD_COLUMNS: Record<RuleValueField, string> = {
  genre: "genres_json",
  category: "categories_json",
  developer: "developers_json",
  publisher: "publishers_json",
};

export interface RuleValuesQuery {
  field: RuleValueField;
  query: string | null;
  page: number;
  pageSize: number;
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
    const rows = allSync<ValueRow>(
      this.db,
      queryFor(this.db)
        .selectFrom("storefront_appdetails as sf")
        .innerJoin("games as g", "g.app_id", "sf.app_id")
        .select(["sf.app_id as app_id", sql<string | null>`${sql.ref(column)}`.as("value_json")])
        .compile(),
    );

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
