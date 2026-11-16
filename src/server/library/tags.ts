import type BetterSqlite3 from "better-sqlite3";
import { normalizeNameKey } from "../../shared/names.ts";
import type { Pagination, TagSummary, TagsResponse } from "../../shared/types.ts";

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

function pagination(page: number, pageSize: number, totalItems: number): Pagination {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
  };
}

export class TagsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(query: TagsQuery): TagsResponse {
    const normalized = query.query === null ? null : normalizeNameKey(query.query);
    const where = normalized === null ? "" : "WHERE instr(t.name_key, ?) > 0";
    const filter = normalized === null ? [] : [normalized];

    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM (
             SELECT t.id
             FROM tags t JOIN game_tags gt ON gt.tag_id = t.id
             ${where}
             GROUP BY t.id
           )`,
        )
        .get(...filter) as { count: number }
    ).count;

    const rows = this.db
      .prepare(
        `SELECT t.name AS name, COUNT(DISTINCT gt.app_id) AS game_count
         FROM tags t JOIN game_tags gt ON gt.tag_id = t.id
         ${where}
         GROUP BY t.id
         ORDER BY game_count DESC, t.name_key ASC, t.id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...filter, query.pageSize, (query.page - 1) * query.pageSize) as Array<{
      name: string;
      game_count: number;
    }>;

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
