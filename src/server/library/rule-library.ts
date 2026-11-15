import type BetterSqlite3 from "better-sqlite3";
import type { GameSummary, GameOrder, GameSort, Pagination } from "../../shared/types.ts";
import type { Rule } from "../../shared/rules.ts";
import { readTagsForGames, toGameSummary, type GameListResult, type GamesRow } from "./games.ts";
import { gameMatchesRules, type RuleTarget } from "./rule-evaluator.ts";

/**
 * The shared Library projection used by `POST /api/rules/preview`,
 * `GET /api/smart-collections/{id}/games`, and list `matchCount`.
 *
 * Reading once and matching in memory keeps every read path identical: the
 * saved Collection membership and the preview membership cannot drift.
 */

function readJsonArray(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function readPlatforms(raw: string | null): string[] {
  if (raw === null) {
    return [];
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [];
    }
    return ["windows", "mac", "linux"].filter(
      (name) => (value as Record<string, unknown>)[name] === true,
    );
  } catch {
    return [];
  }
}

interface CollectionMembership {
  app_id: number;
  steam_collection_id: string;
}

export interface RuleLibrary {
  rows: GamesRow[];
  targets: Map<number, RuleTarget>;
}

/** Read the Library projection once, including Tags and static membership. */
export function readLibrary(db: BetterSqlite3.Database): RuleLibrary {
  const rows = db.prepare("SELECT * FROM v_games").all() as GamesRow[];
  const tags = readTagsForGames(
    db,
    rows.map((row) => row.app_id),
  );
  const collections = new Map<number, string[]>();
  const membership = db
    .prepare(
      `SELECT scg.app_id AS app_id, scg.steam_collection_id AS steam_collection_id
       FROM steam_collection_games scg
       JOIN steam_collections c ON c.id = scg.steam_collection_id
       WHERE c.is_dynamic = 0
       ORDER BY scg.steam_collection_id ASC`,
    )
    .all() as CollectionMembership[];
  for (const row of membership) {
    const ids = collections.get(row.app_id) ?? [];
    ids.push(row.steam_collection_id);
    collections.set(row.app_id, ids);
  }

  const targets = new Map<number, RuleTarget>();
  for (const row of rows) {
    targets.set(row.app_id, {
      appId: row.app_id,
      name: row.name,
      playtimeMinutes: row.playtime_minutes,
      installed: row.installed === null ? null : row.installed === 1,
      ownershipStatus: row.ownership_status,
      lastPlayedAt: row.last_played_at,
      releaseYear: row.release_year,
      metacriticScore: row.metacritic_score,
      reviewScore: row.review_score,
      reviewTier: row.review_tier,
      reviewCount: row.review_total,
      storefrontType: row.type,
      platforms: readPlatforms(row.platforms_json),
      genres: readJsonArray(row.genres_json),
      categories: readJsonArray(row.categories_json),
      developers: readJsonArray(row.developers_json),
      publishers: readJsonArray(row.publishers_json),
      tags: (tags.get(row.app_id) ?? []).map((tag) => tag.name),
      steamCollections: collections.get(row.app_id) ?? [],
    });
  }
  return { rows, targets };
}

/** Match one Library projection; returns rows in `v_games` order. */
export function evaluateLibrary(library: RuleLibrary, rules: readonly Rule[]): GamesRow[] {
  return library.rows.filter((row) => {
    const target = library.targets.get(row.app_id);
    return target !== undefined && gameMatchesRules(rules, target);
  });
}

/** Count one Library projection without materializing the matching rows. */
export function countLibraryMatches(library: RuleLibrary, rules: readonly Rule[]): number {
  let count = 0;
  for (const row of library.rows) {
    const target = library.targets.get(row.app_id);
    if (target !== undefined && gameMatchesRules(rules, target)) {
      count += 1;
    }
  }
  return count;
}

export interface GamePageQuery {
  page: number;
  pageSize: number;
  sort: GameSort;
  order: GameOrder;
}

type SortValue = string | number | null;

function sortValue(row: GamesRow, sort: GameSort): SortValue {
  switch (sort) {
    case "name":
      return row.name_key;
    case "playtime":
      return row.playtime_minutes;
    case "lastPlayed":
      return row.last_played_at;
    case "releaseYear":
      return row.release_year;
    case "metacritic":
      return row.metacritic_score;
    case "appId":
      return row.app_id;
  }
}

/**
 * The SQL comparator from `gameOrderSql`: nulls last in both directions, the
 * chosen direction, then `app_id ASC`.
 */
function compareGames(left: GamesRow, right: GamesRow, sort: GameSort, order: GameOrder): number {
  if (sort === "appId") {
    const difference = left.app_id - right.app_id;
    return order === "desc" ? -difference : difference;
  }

  const leftValue = sortValue(left, sort);
  const rightValue = sortValue(right, sort);
  if (leftValue === null && rightValue === null) {
    return left.app_id - right.app_id;
  }
  if (leftValue === null) {
    return 1;
  }
  if (rightValue === null) {
    return -1;
  }

  const difference =
    typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue) < String(rightValue)
        ? -1
        : String(leftValue) > String(rightValue)
          ? 1
          : 0;
  if (difference !== 0) {
    return order === "desc" ? -difference : difference;
  }
  return left.app_id - right.app_id;
}

export function pagination(page: number, pageSize: number, totalItems: number): Pagination {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
  };
}

/** Sort and page matched rows, then load Tags for the visible page only. */
export function pageMatches(
  db: BetterSqlite3.Database,
  matched: GamesRow[],
  query: GamePageQuery,
): Pick<GameListResult, "data" | "pagination"> {
  const sorted = [...matched].sort((left, right) =>
    compareGames(left, right, query.sort, query.order),
  );
  const offset = (query.page - 1) * query.pageSize;
  const pageRows = sorted.slice(offset, offset + query.pageSize);
  const tags = readTagsForGames(
    db,
    pageRows.map((row) => row.app_id),
  );
  const data: GameSummary[] = pageRows.map((row) => toGameSummary(row, tags.get(row.app_id) ?? []));
  return {
    data,
    pagination: pagination(query.page, query.pageSize, sorted.length),
  };
}
