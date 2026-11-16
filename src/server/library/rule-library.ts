import type BetterSqlite3 from "better-sqlite3";
import type { GameSummary, GameOrder, GameSort, Pagination } from "../../shared/types.ts";
import type { Rule } from "../../shared/rules.ts";
import { readTagsForGames, toGameSummary, type GameListResult, type GamesRow } from "./games.ts";
import { compileRules, type RuleTarget } from "./rule-evaluator.ts";

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

/**
 * The evaluator's Game projection. JSON-backed list Fields are parsed on first
 * access and cached, so a Rules array that never reads Genres does not pay for
 * 20,000 Genre parses. The observable values are unchanged.
 */
class LibraryRuleTarget implements RuleTarget {
  readonly appId: number;
  readonly name: string;
  readonly playtimeMinutes: number;
  readonly installed: boolean | null;
  readonly ownershipStatus: "owned" | "local_only" | "unknown";
  readonly lastPlayedAt: number | null;
  readonly releaseYear: number | null;
  readonly metacriticScore: number | null;
  readonly reviewScore: number | null;
  readonly reviewTier: string | null;
  readonly reviewCount: number | null;
  readonly storefrontType: string | null;
  readonly tags: readonly string[];
  readonly steamCollections: readonly string[];
  private readonly row: GamesRow;
  private platformsCache: string[] | null = null;
  private genresCache: string[] | null = null;
  private categoriesCache: string[] | null = null;
  private developersCache: string[] | null = null;
  private publishersCache: string[] | null = null;

  constructor(row: GamesRow, tags: readonly string[], steamCollections: readonly string[]) {
    this.row = row;
    this.appId = row.app_id;
    this.name = row.name;
    this.playtimeMinutes = row.playtime_minutes;
    this.installed = row.installed === null ? null : row.installed === 1;
    this.ownershipStatus = row.ownership_status;
    this.lastPlayedAt = row.last_played_at;
    this.releaseYear = row.release_year;
    this.metacriticScore = row.metacritic_score;
    this.reviewScore = row.review_score;
    this.reviewTier = row.review_tier;
    this.reviewCount = row.review_total;
    this.storefrontType = row.type;
    this.tags = tags;
    this.steamCollections = steamCollections;
  }

  get platforms(): readonly string[] {
    return (this.platformsCache ??= readPlatforms(this.row.platforms_json));
  }

  get genres(): readonly string[] {
    return (this.genresCache ??= readJsonArray(this.row.genres_json));
  }

  get categories(): readonly string[] {
    return (this.categoriesCache ??= readJsonArray(this.row.categories_json));
  }

  get developers(): readonly string[] {
    return (this.developersCache ??= readJsonArray(this.row.developers_json));
  }

  get publishers(): readonly string[] {
    return (this.publishersCache ??= readJsonArray(this.row.publishers_json));
  }
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
    const tagNames = tags.get(row.app_id);
    targets.set(
      row.app_id,
      new LibraryRuleTarget(
        row,
        tagNames === undefined ? [] : tagNames.map((tag) => tag.name),
        collections.get(row.app_id) ?? [],
      ),
    );
  }
  return { rows, targets };
}

/** Match one Library projection; returns rows in `v_games` order. */
export function evaluateLibrary(library: RuleLibrary, rules: readonly Rule[]): GamesRow[] {
  const compiled = compileRules(rules);
  return library.rows.filter((row) => {
    const target = library.targets.get(row.app_id);
    return target !== undefined && compiled.matches(target);
  });
}

/** Count one Library projection without materializing the matching rows. */
export function countLibraryMatches(library: RuleLibrary, rules: readonly Rule[]): number {
  const compiled = compileRules(rules);
  let count = 0;
  for (const row of library.rows) {
    const target = library.targets.get(row.app_id);
    if (target !== undefined && compiled.matches(target)) {
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
 * The SQL comparator from the read path (`sortColumn`): nulls last in both directions, the
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
