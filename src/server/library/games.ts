import type BetterSqlite3 from "better-sqlite3";
import { normalizeNameKey } from "../../shared/names.ts";
import type { GameDetail, GamePlatforms, GameSummary, Pagination } from "../../shared/types.ts";
import { HttpError } from "../errors.ts";

export const GAME_SORTS = [
  "name",
  "playtime",
  "lastPlayed",
  "releaseYear",
  "metacritic",
  "appId",
] as const;
export type GameSort = (typeof GAME_SORTS)[number];

export type GameOrder = "asc" | "desc";

export interface GamesQuery {
  search: string | null;
  sort: GameSort;
  order: GameOrder;
  installed: boolean | null;
  tagsStatus: string | null;
  storeStatus: string | null;
  reviewStatus: string | null;
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

  let installed: boolean | null = null;
  if (raw.installed !== undefined && raw.installed !== "") {
    if (raw.installed === "true") {
      installed = true;
    } else if (raw.installed === "false") {
      installed = false;
    } else {
      fieldErrors.installed = "must be true or false";
    }
  }

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

  if (Object.keys(fieldErrors).length > 0) {
    throw validationError(fieldErrors);
  }

  return {
    search,
    sort,
    order,
    installed,
    tagsStatus: statusFilter(raw.tagsStatus, "tags", "tagsStatus"),
    storeStatus: statusFilter(raw.storeStatus, "store", "storeStatus"),
    reviewStatus: statusFilter(raw.reviewStatus, "review", "reviewStatus"),
    page,
    pageSize,
  };
}

interface GamesRow {
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

function toIso(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
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

function toSummary(row: GamesRow): GameSummary {
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
    // Tags belong to the Metadata slice; the Library intentionally shows [].
    tags: [],
    metadata: {
      tagsStatus: row.tags_status,
      storeStatus: row.store_status,
      reviewStatus: row.review_status,
    },
  };
}

function toDetail(row: GamesRow): GameDetail {
  const summary = toSummary(row);
  return {
    ...summary,
    releaseDateRaw: row.release_date_raw,
    developers: parseJsonArray(row.developers_json),
    publishers: parseJsonArray(row.publishers_json),
    genres: parseJsonArray(row.genres_json),
    categories: parseJsonArray(row.categories_json),
    steamCollections: [],
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

export interface LibraryScanState {
  lastScanAt: number | null;
  lastScanStatus: "never" | "ok" | "partial" | "failed";
}

export interface GameListResult {
  data: GameSummary[];
  pagination: Pagination;
  meta: { dataAsOf: string | null };
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

    const whereSql = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS count FROM v_games ${whereSql}`).get(...parameters) as {
        count: number;
      }
    ).count;

    const column = SORT_COLUMNS[query.sort];
    const direction = query.order === "desc" ? "DESC" : "ASC";
    const orderSql =
      query.sort === "appId"
        ? `ORDER BY app_id ${direction}`
        : `ORDER BY (${column} IS NULL) ASC, ${column} ${direction}, app_id ASC`;

    const offset = (query.page - 1) * query.pageSize;
    const rows = this.db
      .prepare(`SELECT * FROM v_games ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
      .all(...parameters, query.pageSize, offset) as GamesRow[];

    return {
      data: rows.map(toSummary),
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
    return row === undefined ? null : toDetail(row);
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

  scanState(): LibraryScanState {
    const row = this.db
      .prepare(
        `SELECT status, finished_at FROM refresh_runs
         WHERE scope = 'library'
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as { status: string; finished_at: number | null } | undefined;
    if (row === undefined) {
      return { lastScanAt: null, lastScanStatus: "never" };
    }
    return {
      lastScanAt: row.finished_at,
      lastScanStatus:
        row.status === "succeeded"
          ? "ok"
          : row.status === "partial"
            ? "partial"
            : row.status === "failed"
              ? "failed"
              : "never",
    };
  }

  dataAsOf(): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(value) AS at FROM (
           SELECT MAX(finished_at) AS value FROM refresh_runs
             WHERE status = 'succeeded' AND scope IN ('library', 'ownership')
           UNION ALL
           SELECT MAX(last_success_at) FROM source_state
             WHERE name IN ('steamspy', 'storefront', 'steam_reviews')
         )`,
      )
      .get() as { at: number | null };
    return toIso(row.at);
  }
}
