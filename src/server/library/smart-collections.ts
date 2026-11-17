import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type BetterSqlite3 from "better-sqlite3";
import {
  MAX_RULE_NAME_CODE_POINTS,
  collectionNameProblem,
  normalizeCollectionName,
  validateRules,
  type Rule,
} from "../../shared/rules.ts";
import type {
  SmartCollection,
  SmartCollectionGamesResponse,
  SmartCollectionListItem,
  SmartCollectionsResponse,
  SmartCollectionSort,
} from "../../shared/smart-collections.ts";
import type { GameOrder } from "../../shared/types.ts";
import { normalizeNameKey } from "../../shared/names.ts";
import { GAME_SORTS } from "../../shared/types.ts";
import { HttpError } from "../errors.ts";
import { allSync, firstSync, queryFor } from "../db/query.ts";
import { notFound } from "../request.ts";
import { toIsoTimestamp as toIso } from "../timestamps.ts";
import { readDataAsOf } from "./games.ts";
import {
  countLibraryMatches,
  evaluateLibrary,
  pageMatches,
  pagination,
  readLibrary,
} from "./rule-library.ts";

export interface SmartCollectionsQuery {
  page: number;
  pageSize: number;
  sort: SmartCollectionSort;
  order: GameOrder;
}

export interface SmartCollectionGamesQuery {
  page: number;
  pageSize: number;
  sort: (typeof GAME_SORTS)[number];
  order: GameOrder;
}

interface SmartCollectionRow {
  id: string;
  name: string;
  name_key: string;
  created_at: number;
  updated_at: number;
}

interface RuleRow {
  smart_collection_id: string;
  position: number;
  prefix: Rule["prefix"];
  field: Rule["field"];
  operator: Rule["operator"];
  value_json: string;
}

function nameConflict(conflictingId: string): HttpError {
  return new HttpError(409, "NAME_CONFLICT", "A Smart Collection with that name already exists.", {
    details: { conflictingId },
  });
}

/** Validate and normalize one Smart Collection name (§2.5, §4.4). */
export function validateSmartCollectionName(
  value: unknown,
  fieldErrors: Record<string, string>,
): string | null {
  if (typeof value !== "string") {
    fieldErrors.name = value === undefined ? "is required" : "must be a string";
    return null;
  }
  const problem = collectionNameProblem(value);
  if (problem === "control") {
    fieldErrors.name = "must not contain control characters";
    return null;
  }
  if (problem !== null) {
    fieldErrors.name = `must be 1-${MAX_RULE_NAME_CODE_POINTS} characters`;
    return null;
  }
  return normalizeCollectionName(value);
}

/** Validate `POST /api/smart-collections`; `rules` defaults to `[]`. */

/** Validate `PATCH /api/smart-collections/{id}`; at least one field is required. */

function parseRuleValue(raw: string): Rule["value"] {
  try {
    return JSON.parse(raw) as Rule["value"];
  } catch {
    return "";
  }
}

function serializedRuleValue(rule: Rule): string {
  return JSON.stringify(rule.value);
}

export class SmartCollectionsRepository {
  private readonly now: () => number;

  constructor(
    private readonly db: BetterSqlite3.Database,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  list(query: SmartCollectionsQuery): SmartCollectionsResponse {
    const count = firstSync<{ count: number }>(
      this.db,
      queryFor(this.db)
        .selectFrom("smart_collections")
        .select((expression) => expression.fn.countAll().as("count"))
        .compile(),
    );
    const total = Number(count?.count ?? 0);

    const orderColumn = query.sort === "updatedAt" ? "updated_at" : "name_key";
    const direction = query.order === "desc" ? "desc" : "asc";
    const rows = allSync<SmartCollectionRow>(
      this.db,
      queryFor(this.db)
        .selectFrom("smart_collections")
        .select(["id as id", "name as name", "name_key as name_key"])
        .select(["created_at as created_at", "updated_at as updated_at"])
        .orderBy(sql.ref(orderColumn), direction)
        .orderBy("id", "asc")
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .compile(),
    );

    // One Library pass supplies every matchCount on this page (§4.2).
    const library = rows.length === 0 ? null : readLibrary(this.db);
    const rulesByCollection = this.readRules(rows.map((row) => row.id));
    const data: SmartCollectionListItem[] = rows.map((row) => {
      const rules = rulesByCollection.get(row.id) ?? [];
      return {
        id: row.id,
        name: row.name,
        ruleCount: rules.length,
        matchCount: library === null ? 0 : countLibraryMatches(library, rules),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
      };
    });

    return {
      data,
      pagination: pagination(query.page, query.pageSize, total),
      meta: { dataAsOf: readDataAsOf(this.db) },
    };
  }

  get(id: string): SmartCollection | null {
    const row = firstSync<SmartCollectionRow>(
      this.db,
      queryFor(this.db)
        .selectFrom("smart_collections")
        .select(["id as id", "name as name", "name_key as name_key"])
        .select(["created_at as created_at", "updated_at as updated_at"])
        .where("id", "=", id)
        .compile(),
    );
    if (row === undefined) {
      return null;
    }
    return this.toSmartCollection(row, this.readRules([id]).get(id) ?? []);
  }

  create(input: { name: string; rules: Rule[] }): SmartCollection {
    const id = randomUUID();
    const now = this.now();
    this.db.transaction(() => {
      this.assertNameAvailable(input.name, null);
      this.db
        .prepare(
          `INSERT INTO smart_collections (id, name, name_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, input.name, normalizeNameKey(input.name), now, now);
      this.insertRules(id, input.rules);
    })();

    return this.get(id)!;
  }

  update(id: string, input: { name?: string; rules?: Rule[] }): SmartCollection {
    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM smart_collections WHERE id = ?").get(id) as
        { id: string } | undefined;
      if (existing === undefined) {
        throw notFound(id, "Smart Collection");
      }

      if (input.name !== undefined) {
        this.assertNameAvailable(input.name, id);
        this.db
          .prepare("UPDATE smart_collections SET name = ?, name_key = ? WHERE id = ?")
          .run(input.name, normalizeNameKey(input.name), id);
      }

      if (input.rules !== undefined) {
        this.db.prepare("DELETE FROM rules WHERE smart_collection_id = ?").run(id);
        this.insertRules(id, input.rules);
      }

      this.db
        .prepare("UPDATE smart_collections SET updated_at = ? WHERE id = ?")
        .run(this.now(), id);
    })();

    return this.get(id)!;
  }

  delete(id: string): void {
    const result = this.db.prepare("DELETE FROM smart_collections WHERE id = ?").run(id);
    if (result.changes === 0) {
      throw notFound(id, "Smart Collection");
    }
  }

  games(id: string, query: SmartCollectionGamesQuery): SmartCollectionGamesResponse | null {
    const collection = this.get(id);
    if (collection === null) {
      return null;
    }
    const library = readLibrary(this.db);
    const matched = evaluateLibrary(library, collection.rules);
    const page = pageMatches(this.db, matched, query);
    return {
      ...page,
      meta: { dataAsOf: readDataAsOf(this.db) },
    };
  }

  private assertNameAvailable(name: string, exceptId: string | null): void {
    const row = this.db
      .prepare("SELECT id FROM smart_collections WHERE name_key = ? AND id IS NOT ?")
      .get(normalizeNameKey(name), exceptId) as { id: string } | undefined;
    if (row !== undefined) {
      throw nameConflict(row.id);
    }
  }

  private insertRules(collectionId: string, rules: readonly Rule[]): void {
    const insert = this.db.prepare(
      `INSERT INTO rules (smart_collection_id, position, prefix, field, operator, value_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    rules.forEach((rule, position) => {
      insert.run(
        collectionId,
        position,
        rule.prefix,
        rule.field,
        rule.operator,
        serializedRuleValue(rule),
      );
    });
  }

  private readRules(collectionIds: readonly string[]): Map<string, Rule[]> {
    const result = new Map<string, Rule[]>();
    if (collectionIds.length === 0) {
      return result;
    }
    const rows = allSync<RuleRow>(
      this.db,
      queryFor(this.db)
        .selectFrom("rules")
        .select([
          "smart_collection_id as smart_collection_id",
          "position as position",
          "prefix as prefix",
          "field as field",
          "operator as operator",
          "value_json as value_json",
        ])
        .where("smart_collection_id", "in", [...collectionIds])
        .orderBy("smart_collection_id", "asc")
        .orderBy("position", "asc")
        .compile(),
    );
    for (const row of rows) {
      const rules = result.get(row.smart_collection_id) ?? [];
      rules.push({
        prefix: row.prefix,
        field: row.field,
        operator: row.operator,
        value: parseRuleValue(row.value_json),
      });
      result.set(row.smart_collection_id, rules);
    }
    return result;
  }

  private toSmartCollection(row: SmartCollectionRow, rules: Rule[]): SmartCollection {
    return {
      id: row.id,
      name: row.name,
      rules,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  }
}
