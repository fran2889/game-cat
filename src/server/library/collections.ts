import type BetterSqlite3 from "better-sqlite3";
import { sql } from "kysely";
import type {
  GameSummary,
  SteamCollectionGamesResponse,
  SteamCollectionKind,
  SteamCollectionSummary,
  SteamCollectionsResponse,
} from "../../shared/types.ts";
import { allSync, firstSync, queryFor } from "../db/query.ts";
import { pagination } from "./pagination.ts";
import {
  applyGameOrder,
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

export class SteamCollectionsRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(query: SteamCollectionsQuery): SteamCollectionsResponse {
    const count = firstSync<{ count: number }>(
      this.db,
      queryFor(this.db)
        .selectFrom("steam_collections")
        .select((expression) => expression.fn.countAll().as("count"))
        .compile(),
    );
    const total = Number(count?.count ?? 0);
    const rows = allSync<CollectionRow>(
      this.db,
      queryFor(this.db)
        .selectFrom("steam_collections as c")
        .select(["c.id as id", "c.name as name", "c.kind as kind", "c.is_dynamic as is_dynamic"])
        .select(
          sql<number>`(SELECT COUNT(*) FROM steam_collection_games g
            WHERE g.steam_collection_id = c.id)`.as("game_count"),
        )
        .orderBy("c.name", "asc")
        .orderBy("c.id", "asc")
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .compile(),
    );

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

    const count = firstSync<{ count: number }>(
      this.db,
      queryFor(this.db)
        .selectFrom("steam_collection_games")
        .select((expression) => expression.fn.countAll().as("count"))
        .where("steam_collection_id", "=", id)
        .compile(),
    );
    const total = Number(count?.count ?? 0);
    const gamesQuery = applyGameOrder(
      queryFor(this.db)
        .selectFrom("v_games as vg")
        .innerJoin("steam_collection_games as scg", "scg.app_id", "vg.app_id")
        .selectAll("vg")
        .where("scg.steam_collection_id", "=", id),
      query.sort,
      query.order,
      "vg.app_id",
    );
    const rows = allSync<GamesRow>(
      this.db,
      gamesQuery
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .compile(),
    );
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
    const row = firstSync<CollectionRow>(
      this.db,
      queryFor(this.db)
        .selectFrom("steam_collections as c")
        .select(["c.id as id", "c.name as name", "c.kind as kind", "c.is_dynamic as is_dynamic"])
        .select(
          sql<number>`(SELECT COUNT(*) FROM steam_collection_games g
            WHERE g.steam_collection_id = c.id)`.as("game_count"),
        )
        .where("c.id", "=", id)
        .compile(),
    );
    return row === undefined ? null : toSummary(row);
  }
}
