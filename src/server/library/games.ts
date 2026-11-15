import type BetterSqlite3 from "better-sqlite3";
import { normalizeNameKey } from "../../shared/names.ts";
import {
  GAME_SORTS,
  type GameDetail,
  type GameOrder,
  type GamePlatforms,
  type GameSort,
  type GameSummary,
  type GameTag,
  type Pagination,
} from "../../shared/types.ts";
import { HttpError } from "../errors.ts";
import { toIsoTimestamp as toIso } from "../timestamps.ts";

export { GAME_SORTS };
export type { GameOrder, GameSort };

export interface GamesQuery {
  search: string | null;
  sort: GameSort;
  order: GameOrder;
  installed: boolean | null;
  tagsStatus: string | null;
  storeStatus: string | null;
  reviewStatus: string | null;
  tagsFetched: boolean | null;
  storeFetched: boolean | null;
  reviewFetched: boolean | null;
  page: number;
  pageSize: number;
}

const STATUS_VALUES: Record<"tags" | "store" | "review", readonly string[]> = {
  tags: ["ok", "missing", "stale", "error"],
  store: ["ok", "unavailable", "missing", "stale", "error"],
  review: ["ok", "unavailable", "missing", "stale", "error"],
};

const SORT_COLUMNS: Record<GameSort, string> = {
  name: "name_key",
  playtime: "playtime_minutes",
  lastPlayed: "last_played_at",
  releaseYear: "release_year",
  metacritic: "metacritic_score",
  appId: "app_id",
};

type RawQuery = Record<string, string | undefined>;

function validationError(fieldErrors: Record<string, string>): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", "Request query is invalid", {
    details: { fieldErrors },
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

/** Parse and validate `GET /api/games` query parameters (§4.3). */
export function parseGamesQuery(raw: RawQuery, pageSizeMax = 200): GamesQuery {
  const fieldErrors: Record<string, string> = {};

  const searchRaw = raw.search;
  let search: string | null = null;
  if (searchRaw !== undefined && searchRaw.trim() !== "") {
    if (searchRaw.length > 200) {
      fieldErrors.search = "must be at most 200 characters";
    } else {
      search = searchRaw;
    }
  }

  const sort = (raw.sort ?? "name") as GameSort;
  if (!GAME_SORTS.includes(sort)) {
    fieldErrors.sort = `must be one of ${GAME_SORTS.join(", ")}`;
  }
  const order = (raw.order ?? "asc") as GameOrder;
  if (order !== "asc" && order !== "desc") {
    fieldErrors.order = "must be asc or desc";
  }

  const booleanFilter = (value: string | undefined, key: string): boolean | null => {
    if (value === undefined || value === "") {
      return null;
    }
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    fieldErrors[key] = "must be true or false";
    return null;
  };

  const installed = booleanFilter(raw.installed, "installed");

  const statusFilter = (
    value: string | undefined,
    field: "tags" | "store" | "review",
    key: string,
  ): string | null => {
    if (value === undefined || value === "") {
      return null;
    }
    if (!STATUS_VALUES[field].includes(value)) {
      fieldErrors[key] = `must be one of ${STATUS_VALUES[field].join(", ")}`;
      return null;
    }
    return value;
  };

  const page = parseInteger(raw.page, 1, "page", 1, Number.MAX_SAFE_INTEGER, fieldErrors);
  const pageSize = parseInteger(raw.pageSize, 60, "pageSize", 1, pageSizeMax, fieldErrors);
  const tagsStatus = statusFilter(raw.tagsStatus, "tags", "tagsStatus");
  const storeStatus = statusFilter(raw.storeStatus, "store", "storeStatus");
  const reviewStatus = statusFilter(raw.reviewStatus, "review", "reviewStatus");
  const tagsFetched = booleanFilter(raw.tagsFetched, "tagsFetched");
  const storeFetched = booleanFilter(raw.storeFetched, "storeFetched");
  const reviewFetched = booleanFilter(raw.reviewFetched, "reviewFetched");

  if (Object.keys(fieldErrors).length > 0) {
    throw validationError(fieldErrors);
  }

  return {
    search,
    sort,
    order,
    installed,
    tagsStatus,
    storeStatus,
    reviewStatus,
    tagsFetched,
    storeFetched,
    reviewFetched,
    page,
    pageSize,
  };
}

export interface GamesRow {
  app_id: number;
  name: string;
  name_key: string;
  name_source: string;
  ownership_status: "owned" | "local_only" | "unknown";
  installed: number | null;
  library_path: string | null;
  install_dir: string | null;
  size_on_disk_bytes: number | null;
  state_flags: number | null;
  local_playtime_minutes: number | null;
  api_playtime_minutes: number | null;
  playtime_minutes: number;
  local_playtime_2weeks_minutes: number | null;
  api_playtime_2weeks_minutes: number | null;
  playtime_2weeks_minutes: number | null;
  last_updated_at: number | null;
  source_mask: number;
  first_seen_at: number;
  last_seen_at: number;
  last_played_at: number | null;
  type: string | null;
  developers_json: string | null;
  publishers_json: string | null;
  genres_json: string | null;
  categories_json: string | null;
  platforms_json: string | null;
  release_date_raw: string | null;
  release_year: number | null;
  metacritic_score: number | null;
  tags_status: string;
  tags_fetched_at: number | null;
  store_status: string;
  store_fetched_at: number | null;
  review_status: string;
  review_fetched_at: number | null;
  review_positive: number | null;
  review_negative: number | null;
  review_total: number | null;
  review_tier: string | null;
  review_score: number | null;
}

function parseJsonArray(raw: string | null): string[] {
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

function parsePlatforms(raw: string | null): GamePlatforms | null {
  if (raw === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const platforms: GamePlatforms = {};
    for (const key of ["windows", "mac", "linux"] as const) {
      const flag = (value as Record<string, unknown>)[key];
      if (typeof flag === "boolean") {
        platforms[key] = flag;
      }
    }
    return platforms;
  } catch {
    return null;
  }
}

export function toGameSummary(row: GamesRow, tags: GameTag[] = []): GameSummary {
  return {
    appId: row.app_id,
    name: row.name,
    ownershipStatus: row.ownership_status,
    installed: row.installed === null ? null : row.installed === 1,
    playtimeMinutes: row.playtime_minutes,
    lastPlayedAt: toIso(row.last_played_at),
    releaseYear: row.release_year,
    metacriticScore: row.metacritic_score,
    reviewScore: row.review_score,
    reviewTier: row.review_tier,
    reviewCount: row.review_total,
    type: row.type,
    platforms: parsePlatforms(row.platforms_json),
    // GameSummary carries at most three Tags (§4.2); GameDetail carries all.
    tags: tags.slice(0, 3),
    metadata: {
      tagsStatus: row.tags_status,
      storeStatus: row.store_status,
      reviewStatus: row.review_status,
    },
  };
}

/** Load Tags for a page of Games in one query, ordered by votes then name. */
export function readTagsForGames(
  db: BetterSqlite3.Database,
  appIds: number[],
): Map<number, GameTag[]> {
  const tags = new Map<number, GameTag[]>();
  if (appIds.length === 0) {
    return tags;
  }
  const placeholders = appIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT gt.app_id AS app_id, t.name AS name, gt.votes AS votes
       FROM game_tags gt
       JOIN tags t ON t.id = gt.tag_id
       WHERE gt.app_id IN (${placeholders})
       ORDER BY gt.app_id ASC, gt.votes DESC, t.name ASC, t.id ASC`,
    )
    .all(...appIds) as Array<{ app_id: number; name: string; votes: number }>;
  for (const row of rows) {
    const list = tags.get(row.app_id) ?? [];
    list.push({ name: row.name, votes: row.votes });
    tags.set(row.app_id, list);
  }
  return tags;
}

function toDetail(
  row: GamesRow,
  steamCollections: Array<{ id: string; name: string; kind: string }>,
  tags: GameTag[],
): GameDetail {
  const summary = toGameSummary(row, tags);
  return {
    ...summary,
    tags,
    releaseDateRaw: row.release_date_raw,
    developers: parseJsonArray(row.developers_json),
    publishers: parseJsonArray(row.publishers_json),
    genres: parseJsonArray(row.genres_json),
    categories: parseJsonArray(row.categories_json),
    steamCollections,
    sizeOnDiskBytes: row.size_on_disk_bytes,
    metadata: {
      ...summary.metadata,
      tagsFetchedAt: toIso(row.tags_fetched_at),
      storeFetchedAt: toIso(row.store_fetched_at),
      reviewFetchedAt: toIso(row.review_fetched_at),
    },
  };
}

export interface LibraryCounts {
  gameCount: number;
  installedCount: number;
}

export interface OwnershipCounts {
  owned: number;
  localOnly: number;
  unknown: number;
}

export interface LibraryScanState {
  lastScanAt: number | null;
  lastScanStatus: "never" | "ok" | "partial" | "failed";
}

export interface GameListResult {
  data: GameSummary[];
  pagination: Pagination;
  meta: { dataAsOf: string | null };
}

/** Shared sorting SQL for every endpoint that pages Games. */
export function gameOrderSql(sort: GameSort, order: GameOrder): string {
  const column = SORT_COLUMNS[sort];
  const direction = order === "desc" ? "DESC" : "ASC";
  return sort === "appId"
    ? `ORDER BY app_id ${direction}`
    : `ORDER BY (${column} IS NULL) ASC, ${column} ${direction}, app_id ASC`;
}

export function readDataAsOf(db: BetterSqlite3.Database): string | null {
  // Every phase of a direct scope or an `all` run records its success in
  // `source_state`. The later of the local scan, ownership refresh, and
  // Metadata completion is the documented `meta.dataAsOf`.
  const row = db
    .prepare(
      `SELECT MAX(last_success_at) AS at FROM source_state
       WHERE name IN ('steam_local', 'steam_web_api', 'steamspy', 'storefront', 'steam_reviews')`,
    )
    .get() as { at: number | null };
  return toIso(row.at);
}

export class GamesRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(query: GamesQuery): GameListResult {
    const where: string[] = [];
    const parameters: unknown[] = [];

    if (query.search !== null) {
      where.push("instr(name_key, ?) > 0");
      parameters.push(normalizeNameKey(query.search));
    }
    if (query.installed !== null) {
      where.push("installed = ?");
      parameters.push(query.installed ? 1 : 0);
    }
    if (query.tagsStatus !== null) {
      where.push("tags_status = ?");
      parameters.push(query.tagsStatus);
    }
    if (query.storeStatus !== null) {
      where.push("store_status = ?");
      parameters.push(query.storeStatus);
    }
    if (query.reviewStatus !== null) {
      where.push("review_status = ?");
      parameters.push(query.reviewStatus);
    }
    if (query.tagsFetched !== null) {
      where.push(query.tagsFetched ? "tags_fetched_at IS NOT NULL" : "tags_fetched_at IS NULL");
    }
    if (query.storeFetched !== null) {
      where.push(query.storeFetched ? "store_fetched_at IS NOT NULL" : "store_fetched_at IS NULL");
    }
    if (query.reviewFetched !== null) {
      where.push(
        query.reviewFetched ? "review_fetched_at IS NOT NULL" : "review_fetched_at IS NULL",
      );
    }

    const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM v_games ${whereSql}`).get(...parameters) as {
        count: number;
      }
    ).count;

    const orderSql = gameOrderSql(query.sort, query.order);

    const offset = (query.page - 1) * query.pageSize;
    const rows = this.db
      .prepare(`SELECT * FROM v_games ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
      .all(...parameters, query.pageSize, offset) as GamesRow[];
    const tags = readTagsForGames(
      this.db,
      rows.map((row) => row.app_id),
    );

    return {
      data: rows.map((row) => toGameSummary(row, tags.get(row.app_id) ?? [])),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: total,
        totalPages: total === 0 ? 0 : Math.ceil(total / query.pageSize),
      },
      meta: { dataAsOf: this.dataAsOf() },
    };
  }

  get(appId: number): GameDetail | null {
    const row = this.db.prepare("SELECT * FROM v_games WHERE app_id = ?").get(appId) as
      GamesRow | undefined;
    if (row === undefined) {
      return null;
    }
    return toDetail(
      row,
      this.collectionsFor(appId),
      readTagsForGames(this.db, [appId]).get(appId) ?? [],
    );
  }

  /** Static Steam Collections containing the Game, for GameDetail. */
  collectionsFor(appId: number): Array<{ id: string; name: string; kind: string }> {
    return this.db
      .prepare(
        `SELECT c.id, c.name, c.kind
         FROM steam_collections c
         JOIN steam_collection_games scg ON scg.steam_collection_id = c.id
         WHERE scg.app_id = ? AND c.is_dynamic = 0
         ORDER BY c.name ASC, c.id ASC`,
      )
      .all(appId) as Array<{ id: string; name: string; kind: string }>;
  }

  counts(): LibraryCounts {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS gameCount,
                COALESCE(SUM(CASE WHEN installed = 1 THEN 1 ELSE 0 END), 0) AS installedCount
         FROM games`,
      )
      .get() as { gameCount: number; installedCount: number };
    return { gameCount: row.gameCount, installedCount: row.installedCount };
  }

  ownershipCounts(): OwnershipCounts {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN ownership_status = 'owned' THEN 1 ELSE 0 END), 0) AS owned,
                COALESCE(SUM(CASE WHEN ownership_status = 'local_only' THEN 1 ELSE 0 END), 0) AS localOnly,
                COALESCE(SUM(CASE WHEN ownership_status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown
         FROM games`,
      )
      .get() as OwnershipCounts;
    return { owned: row.owned, localOnly: row.localOnly, unknown: row.unknown };
  }

  scanState(): LibraryScanState {
    // A direct `library` run and the library phase of an `all` run both write
    // `source_state.steam_local`; the latest attempt is the latest scan.
    const row = this.db
      .prepare("SELECT status, last_attempt_at FROM source_state WHERE name = 'steam_local'")
      .get() as { status: string; last_attempt_at: number | null } | undefined;
    if (row === undefined || row.status === "unknown" || row.last_attempt_at === null) {
      return { lastScanAt: null, lastScanStatus: "never" };
    }
    return {
      lastScanAt: row.last_attempt_at,
      lastScanStatus:
        row.status === "ok"
          ? "ok"
          : row.status === "partial"
            ? "partial"
            : row.status === "error"
              ? "failed"
              : "never",
    };
  }

  dataAsOf(): string | null {
    return readDataAsOf(this.db);
  }
}
