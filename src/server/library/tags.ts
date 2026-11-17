import type BetterSqlite3 from "better-sqlite3";
import { normalizeNameKey } from "../../shared/names.ts";
import { sql, type SqlBool } from "kysely";
import type { TagSummary, TagsResponse } from "../../shared/types.ts";
import { allSync, firstSync, queryFor } from "../db/query.ts";
import { pagination } from "./pagination.ts";

/**
 * `GET /api/tags` typeahead (spec §4.3, AC-A6).
 *
 * Reads the persisted Tag vocabulary and counts distinct Games. Tags with no
 * Game are never returned, so a stale vocabulary row cannot leak a dead value.
 */

export interface TagsQuery {
  query: string | null;
  page: number;
  pageSize: number;
}

export class TagsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(query: TagsQuery): TagsResponse {
    const normalized = query.query === null ? null : normalizeNameKey(query.query);
    let countQuery = queryFor(this.db)
      .selectFrom("tags as t")
      .innerJoin("game_tags as gt", "gt.tag_id", "t.id")
      .select(sql<number>`COUNT(DISTINCT t.id)`.as("count"));
    if (normalized !== null) {
      countQuery = countQuery.where(sql<SqlBool>`instr(t.name_key, ${normalized}) > 0`);
    }
    const count = firstSync<{ count: number }>(this.db, countQuery.compile());
    const total = Number(count?.count ?? 0);

    let rowsQuery = queryFor(this.db)
      .selectFrom("tags as t")
      .innerJoin("game_tags as gt", "gt.tag_id", "t.id")
      .select(["t.name as name", sql<number>`COUNT(DISTINCT gt.app_id)`.as("game_count")])
      .groupBy("t.id");
    if (normalized !== null) {
      rowsQuery = rowsQuery.where(sql<SqlBool>`instr(t.name_key, ${normalized}) > 0`);
    }
    const pagedRowsQuery = rowsQuery
      .orderBy("game_count", "desc")
      .orderBy("t.name_key", "asc")
      .orderBy("t.id", "asc")
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const rows = allSync<{ name: string; game_count: number }>(this.db, pagedRowsQuery.compile());

    const data: TagSummary[] = rows.map((row) => ({
      name: row.name,
      gameCount: row.game_count,
    }));
    return {
      data,
      pagination: pagination(query.page, query.pageSize, total),
    };
  }
}
