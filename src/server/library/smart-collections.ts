import { randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import {
  CONTROL_CHARACTERS,
  MAX_RULE_NAME_CODE_POINTS,
  codePointLength,
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
import { toIsoTimestamp as toIso } from "../timestamps.ts";
import { readDataAsOf } from "./games.ts";
import {
  countLibraryMatches,
  evaluateLibrary,
  pageMatches,
  pagination,
  readLibrary,
} from "./rule-library.ts";

const DEFAULT_PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 200;

type RawQuery = Record<string, string | undefined>;

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

function validationError(fieldErrors: Record<string, string>): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", "Request body is invalid", {
    details: { fieldErrors },
  });
}

function nameConflict(conflictingId: string): HttpError {
  return new HttpError(409, "NAME_CONFLICT", "A Smart Collection with that name already exists.", {
    details: { conflictingId },
  });
}

function notFound(id: string): HttpError {
  return new HttpError(404, "NOT_FOUND", "The requested Smart Collection was not found.", {
    details: { id },
  });
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  field: string,
  min: number,
  max: number,
  fieldErrors: Record<string, string>,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    fieldErrors[field] = `must be an integer between ${min} and ${max}`;
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    fieldErrors[field] = `must be an integer between ${min} and ${max}`;
    return fallback;
  }
  return parsed;
}

export function parseSmartCollectionsQuery(raw: RawQuery): SmartCollectionsQuery {
  const fieldErrors: Record<string, string> = {};
  const page = parseInteger(raw.page, 1, "page", 1, Number.MAX_SAFE_INTEGER, fieldErrors);
  const pageSize = parseInteger(
    raw.pageSize,
    DEFAULT_PAGE_SIZE,
    "pageSize",
    1,
    MAX_PAGE_SIZE,
    fieldErrors,
  );
  const sort = (raw.sort ?? "name") as SmartCollectionSort;
  if (sort !== "name" && sort !== "updatedAt") {
    fieldErrors.sort = "must be one of name, updatedAt";
  }
  const order = (raw.order ?? "asc") as GameOrder;
  if (order !== "asc" && order !== "desc") {
    fieldErrors.order = "must be asc or desc";
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request query is invalid", {
      details: { fieldErrors },
    });
  }
  return { page, pageSize, sort, order };
}

export function parseSmartCollectionGamesQuery(raw: RawQuery): SmartCollectionGamesQuery {
  const fieldErrors: Record<string, string> = {};
  const page = parseInteger(raw.page, 1, "page", 1, Number.MAX_SAFE_INTEGER, fieldErrors);
  const pageSize = parseInteger(
    raw.pageSize,
    DEFAULT_PAGE_SIZE,
    "pageSize",
    1,
    MAX_PAGE_SIZE,
    fieldErrors,
  );
  const sort = (raw.sort ?? "name") as (typeof GAME_SORTS)[number];
  if (!GAME_SORTS.includes(sort)) {
    fieldErrors.sort = `must be one of ${GAME_SORTS.join(", ")}`;
  }
  const order = (raw.order ?? "asc") as GameOrder;
  if (order !== "asc" && order !== "desc") {
    fieldErrors.order = "must be asc or desc";
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new HttpError(422, "VALIDATION_ERROR", "Request query is invalid", {
      details: { fieldErrors },
    });
  }
  return { page, pageSize, sort, order };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  if (CONTROL_CHARACTERS.test(value)) {
    fieldErrors.name = "must not contain control characters";
    return null;
  }
  const name = value.normalize("NFC").trim();
  const length = codePointLength(name);
  if (length < 1 || length > MAX_RULE_NAME_CODE_POINTS) {
    fieldErrors.name = `must be 1-${MAX_RULE_NAME_CODE_POINTS} characters`;
    return null;
  }
  return name;
}

function validateRulesField(value: unknown, fieldErrors: Record<string, string>): Rule[] | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    fieldErrors.rules = "must be an array";
    return null;
  }
  const validated = validateRules(value);
  Object.assign(fieldErrors, validated.fieldErrors);
  if (validated.rules.length !== value.length) {
    return null;
  }
  return validated.rules;
}

export interface ValidatedCreate {
  name: string;
  rules: Rule[];
  fieldErrors: Record<string, string>;
}

/** Validate `POST /api/smart-collections`; `rules` defaults to `[]`. */
export function validateSmartCollectionCreate(input: unknown): ValidatedCreate {
  const fieldErrors: Record<string, string> = {};
  const body = asRecord(input);
  if (body === null) {
    fieldErrors.body = "must be an object";
    return { name: "", rules: [], fieldErrors };
  }
  const name = validateSmartCollectionName(body.name, fieldErrors);
  const rules = validateRulesField(body.rules, fieldErrors) ?? [];
  return { name: name ?? "", rules, fieldErrors };
}

export interface ValidatedPatch {
  name?: string;
  rules?: Rule[];
  fieldErrors: Record<string, string>;
}

/** Validate `PATCH /api/smart-collections/{id}`; at least one field is required. */
export function validateSmartCollectionPatch(input: unknown): ValidatedPatch {
  const fieldErrors: Record<string, string> = {};
  const body = asRecord(input);
  if (body === null) {
    fieldErrors.body = "must be an object";
    return { fieldErrors };
  }

  const hasName = Object.hasOwn(body, "name");
  const hasRules = Object.hasOwn(body, "rules");
  if (!hasName && !hasRules) {
    fieldErrors.body = "must contain name or rules";
    return { fieldErrors };
  }

  let name: string | undefined;
  if (hasName) {
    const validated = validateSmartCollectionName(body.name, fieldErrors);
    if (validated !== null) {
      name = validated;
    }
  }

  let rules: Rule[] | undefined;
  if (hasRules) {
    const validated = validateRulesField(body.rules, fieldErrors);
    if (validated !== null) {
      rules = validated;
    }
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(rules === undefined ? {} : { rules }),
    fieldErrors,
  };
}

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
    const total = (
      this.db.prepare("SELECT COUNT(*) AS count FROM smart_collections").get() as { count: number }
    ).count;

    const orderColumn = query.sort === "updatedAt" ? "updated_at" : "name_key";
    const direction = query.order === "desc" ? "DESC" : "ASC";
    const rows = this.db
      .prepare(
        `SELECT id, name, name_key, created_at, updated_at
         FROM smart_collections
         ORDER BY ${orderColumn} ${direction}, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(query.pageSize, (query.page - 1) * query.pageSize) as SmartCollectionRow[];

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
    const row = this.db
      .prepare(
        "SELECT id, name, name_key, created_at, updated_at FROM smart_collections WHERE id = ?",
      )
      .get(id) as SmartCollectionRow | undefined;
    if (row === undefined) {
      return null;
    }
    return this.toSmartCollection(row, this.readRules([id]).get(id) ?? []);
  }

  create(input: unknown): SmartCollection {
    const validated = validateSmartCollectionCreate(input);
    if (Object.keys(validated.fieldErrors).length > 0) {
      throw validationError(validated.fieldErrors);
    }

    const id = randomUUID();
    const now = this.now();
    this.db.transaction(() => {
      this.assertNameAvailable(validated.name, null);
      this.db
        .prepare(
          `INSERT INTO smart_collections (id, name, name_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, validated.name, normalizeNameKey(validated.name), now, now);
      this.insertRules(id, validated.rules);
    })();

    return this.get(id)!;
  }

  update(id: string, input: unknown): SmartCollection {
    const validated = validateSmartCollectionPatch(input);
    if (Object.keys(validated.fieldErrors).length > 0) {
      throw validationError(validated.fieldErrors);
    }

    this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM smart_collections WHERE id = ?").get(id) as
        { id: string } | undefined;
      if (existing === undefined) {
        throw notFound(id);
      }

      if (validated.name !== undefined) {
        this.assertNameAvailable(validated.name, id);
        this.db
          .prepare("UPDATE smart_collections SET name = ?, name_key = ? WHERE id = ?")
          .run(validated.name, normalizeNameKey(validated.name), id);
      }

      if (validated.rules !== undefined) {
        this.db.prepare("DELETE FROM rules WHERE smart_collection_id = ?").run(id);
        this.insertRules(id, validated.rules);
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
      throw notFound(id);
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
    const placeholders = collectionIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT smart_collection_id, position, prefix, field, operator, value_json
         FROM rules
         WHERE smart_collection_id IN (${placeholders})
         ORDER BY smart_collection_id ASC, position ASC`,
      )
      .all(...collectionIds) as RuleRow[];
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
