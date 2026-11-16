import type BetterSqlite3 from "better-sqlite3";
import type {
  GameSummary,
  Pagination,
  SteamCollectionGamesResponse,
  SteamCollectionKind,
  SteamCollectionSummary,
  SteamCollectionsResponse,
} from "../../shared/types.ts";
import {
  gameOrderSql,
  readDataAsOf,
  readTagsForGames,
  toGameSummary,
  type GameOrder,
  type GamesRow,
  type GameSort,
} from "./games.ts";

/**
 * Read-only queries over the mirrored Steam Collections (spec §4.3, §7.5).
 * Nothing here writes, and `filter_spec_json` never reaches a response.
 */

interface CollectionRow {
  id: string;
  name: string;
  kind: SteamCollectionKind;
  is_dynamic: number;
  game_count: number;
}

export interface SteamCollectionsQuery {
  page: number;
  pageSize: number;
}

export interface SteamCollectionGamesQuery extends SteamCollectionsQuery {
  sort: GameSort;
  order: GameOrder;
}

function toSummary(row: CollectionRow): SteamCollectionSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    isDynamic: row.is_dynamic === 1,
    gameCount: row.is_dynamic === 1 ? null : row.game_count,
  };
}

function pagination(page: number, pageSize: number, totalItems: number): Pagination {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
  };
}

export class SteamCollectionsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(query: SteamCollectionsQuery): SteamCollectionsResponse {
    const total = (
      this.db.prepare("SELECT COUNT(*) AS count FROM steam_collections").get() as { count: number }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.kind, c.is_dynamic,
                (SELECT COUNT(*) FROM steam_collection_games g
                  WHERE g.steam_collection_id = c.id) AS game_count
         FROM steam_collections c
         ORDER BY c.name ASC, c.id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(query.pageSize, (query.page - 1) * query.pageSize) as CollectionRow[];

    return {
      data: rows.map(toSummary),
      pagination: pagination(query.page, query.pageSize, total),
    };
  }

  get(id: string): SteamCollectionSummary | null {
    return this.read(id);
  }

  games(id: string, query: SteamCollectionGamesQuery): SteamCollectionGamesResponse | null {
    const summary = this.read(id);
    if (summary === null) {
      return null;
    }
    if (summary.isDynamic) {
      return {
        data: [],
        pagination: pagination(query.page, query.pageSize, 0),
        meta: { dataAsOf: readDataAsOf(this.db), dynamic: true },
      };
    }

    const total = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM steam_collection_games WHERE steam_collection_id = ?",
        )
        .get(id) as { count: number }
    ).count;
    const rows = this.db
      .prepare(
        `SELECT vg.* FROM v_games vg
         JOIN steam_collection_games scg ON scg.app_id = vg.app_id
         WHERE scg.steam_collection_id = ?
         ${gameOrderSql(query.sort, query.order)}
         LIMIT ? OFFSET ?`,
      )
      .all(id, query.pageSize, (query.page - 1) * query.pageSize) as GamesRow[];
    const tags = readTagsForGames(
      this.db,
      rows.map((row) => row.app_id),
    );

    return {
      data: rows.map((row) => toGameSummary(row, tags.get(row.app_id) ?? [])),
      pagination: pagination(query.page, query.pageSize, total),
      meta: { dataAsOf: readDataAsOf(this.db), dynamic: false },
    };
  }

  private read(id: string): SteamCollectionSummary | null {
    const row = this.db
      .prepare(
        `SELECT c.id, c.name, c.kind, c.is_dynamic,
                (SELECT COUNT(*) FROM steam_collection_games g
                  WHERE g.steam_collection_id = c.id) AS game_count
         FROM steam_collections c WHERE c.id = ?`,
      )
      .get(id) as CollectionRow | undefined;
    return row === undefined ? null : toSummary(row);
  }
}
