import type BetterSqlite3 from "better-sqlite3";
import type { GameSummary, Pagination } from "../../shared/types.ts";
import type { Rule } from "../../shared/rules.ts";
import type { RulesPreviewRequest } from "../../shared/rules.ts";
import {
  readDataAsOf,
  readTagsForGames,
  toGameSummary,
  type GameListResult,
  type GamesRow,
} from "./games.ts";
import { gameMatchesRules, type RuleTarget } from "./rule-evaluator.ts";

/**
 * Evaluates an unsaved Rules array over the current Library (spec §5.5.2).
 *
 * The Library is read once through `v_games` plus Tags and static Steam
 * Collection membership, matched in memory, then sorted and paged. Reads only:
 * the endpoint never persists Rules and never writes a row.
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

interface Library {
  rows: GamesRow[];
  targets: Map<number, RuleTarget>;
}

function readLibrary(db: BetterSqlite3.Database): Library {
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

type SortValue = string | number | null;

function sortValue(row: GamesRow, sort: RulesPreviewRequest["sort"]): SortValue {
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
function compareGames(
  left: GamesRow,
  right: GamesRow,
  sort: RulesPreviewRequest["sort"],
  order: RulesPreviewRequest["order"],
): number {
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

function pagination(page: number, pageSize: number, totalItems: number): Pagination {
  return {
    page,
    pageSize,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
  };
}

export class RulePreviewRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  preview(request: RulesPreviewRequest): GameListResult {
    const rules: Rule[] = request.rules;
    const library = readLibrary(this.db);
    const matched = library.rows.filter((row) => {
      const target = library.targets.get(row.app_id);
      return target !== undefined && gameMatchesRules(rules, target);
    });
    matched.sort((left, right) => compareGames(left, right, request.sort, request.order));

    const offset = (request.page - 1) * request.pageSize;
    const pageRows = matched.slice(offset, offset + request.pageSize);
    const tags = readTagsForGames(
      this.db,
      pageRows.map((row) => row.app_id),
    );
    const data: GameSummary[] = pageRows.map((row) =>
      toGameSummary(row, tags.get(row.app_id) ?? []),
    );

    return {
      data,
      pagination: pagination(request.page, request.pageSize, matched.length),
      meta: { dataAsOf: readDataAsOf(this.db) },
    };
  }
}
