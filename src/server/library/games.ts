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
import { sql, type RawBuilder, type SelectQueryBuilder, type SqlBool } from "kysely";
import { allSync, firstSync, queryFor } from "../db/query.ts";
import type { DatabaseSchema } from "../db/schema.ts";
import { METADATA_SOURCE_NAMES } from "../../shared/types.ts";
import { toIsoTimestamp as toIso } from "../timestamps.ts";
import { pagination } from "./pagination.ts";

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

const SORT_COLUMNS: Record<GameSort, string> = {
  name: "name_key",
  playtime: "playtime_minutes",
  lastPlayed: "last_played_at",
  releaseYear: "release_year",
  metacritic: "metacritic_score",
  appId: "app_id",
};

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
  const query = queryFor(db)
    .selectFrom("game_tags as gt")
    .innerJoin("tags as t", "t.id", "gt.tag_id")
    .select(["gt.app_id as app_id", "t.name as name", "gt.votes as votes"])
    .where("gt.app_id", "in", appIds)
    .orderBy("gt.app_id", "asc")
    .orderBy("gt.votes", "desc")
    .orderBy("t.name", "asc")
    .orderBy("t.id", "asc")
    .compile();
  const rows = allSync<{ app_id: number; name: string; votes: number }>(db, query);
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

/** The typed column a sort key reads, shared with the other read paths. */
export function sortColumn(sort: GameSort): keyof GamesRow & string {
  return SORT_COLUMNS[sort] as keyof GamesRow & string;
}

export interface GameOrderTerm {
  expression: RawBuilder<unknown>;
  direction: "asc" | "desc";
}

type GameSortValue = string | number | null;

interface GameOrderKey {
  column: keyof GamesRow & string;
  direction: "asc" | "desc";
  nullsLast: boolean;
}

/**
 * The one nulls-last ordering rule. Both the SQL terms and the in-memory
 * comparator consume this key list: missing values sort after real ones in
 * both directions, ties follow the chosen direction, then `app_id ASC`.
 */
function gameOrderKeys(sort: GameSort, order: GameOrder): GameOrderKey[] {
  const direction = order === "desc" ? "desc" : "asc";
  if (sort === "appId") {
    return [{ column: "app_id", direction, nullsLast: false }];
  }
  return [
    { column: sortColumn(sort), direction, nullsLast: true },
    { column: "app_id", direction: "asc", nullsLast: false },
  ];
}

/**
 * Render the ordering keys as SQL terms. `appIdColumn` carries the table
 * qualifier for joined reads.
 */
export function gameOrderTerms(
  sort: GameSort,
  order: GameOrder,
  appIdColumn = "app_id",
): GameOrderTerm[] {
  const terms: GameOrderTerm[] = [];
  for (const key of gameOrderKeys(sort, order)) {
    const column = key.column === "app_id" ? appIdColumn : key.column;
    if (key.nullsLast) {
      terms.push({ expression: sql`(${sql.ref(column)} IS NULL)`, direction: "asc" });
    }
    terms.push({ expression: sql.ref(column), direction: key.direction });
  }
  return terms;
}

/** Apply the same ordering keys in memory for the Rule read path. */
export function compareGames(
  left: GamesRow,
  right: GamesRow,
  sort: GameSort,
  order: GameOrder,
): number {
  for (const key of gameOrderKeys(sort, order)) {
    const leftValue = left[key.column];
    const rightValue = right[key.column];
    if (key.nullsLast) {
      if (leftValue === null && rightValue === null) {
        continue;
      }
      if (leftValue === null) {
        return 1;
      }
      if (rightValue === null) {
        return -1;
      }
    }
    const difference = compareSortValues(leftValue, rightValue);
    if (difference !== 0) {
      return key.direction === "desc" ? -difference : difference;
    }
  }
  return 0;
}

function compareSortValues(left: GameSortValue, right: GameSortValue): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (String(left) < String(right)) {
    return -1;
  }
  return String(left) > String(right) ? 1 : 0;
}

/** The phases whose latest success defines `meta.dataAsOf`. */
const DATA_AS_OF_SOURCES = ["steam_local", "steam_web_api", ...METADATA_SOURCE_NAMES];

export function readDataAsOf(db: BetterSqlite3.Database): string | null {
  // Every phase of a direct scope or an `all` run records its success in
  // `source_state`. The later of the local scan, ownership refresh, and
  // Metadata completion is the documented `meta.dataAsOf`.
  const row = firstSync<{ at: number | null }>(
    db,
    queryFor(db)
      .selectFrom("source_state")
      .select(sql<number | null>`MAX(last_success_at)`.as("at"))
      .where("name", "in", DATA_AS_OF_SOURCES)
      .compile(),
  );
  return toIso(row?.at ?? null);
}

type GamesSelect = SelectQueryBuilder<DatabaseSchema, "v_games", object>;

/** Apply the documented Library filters through the typed builder. */
function withGameFilters<T extends GamesSelect>(builder: T, query: GamesQuery): T {
  let next = builder;
  if (query.search !== null) {
    next = next.where(sql<SqlBool>`instr(name_key, ${normalizeNameKey(query.search)}) > 0`) as T;
  }
  if (query.installed !== null) {
    next = next.where("installed", "=", query.installed ? 1 : 0) as T;
  }
  if (query.tagsStatus !== null) {
    next = next.where("tags_status", "=", query.tagsStatus) as T;
  }
  if (query.storeStatus !== null) {
    next = next.where("store_status", "=", query.storeStatus) as T;
  }
  if (query.reviewStatus !== null) {
    next = next.where("review_status", "=", query.reviewStatus) as T;
  }
  const fetchedFilters: Array<
    [boolean | null, "tags_fetched_at" | "store_fetched_at" | "review_fetched_at"]
  > = [
    [query.tagsFetched, "tags_fetched_at"],
    [query.storeFetched, "store_fetched_at"],
    [query.reviewFetched, "review_fetched_at"],
  ];
  for (const [fetched, column] of fetchedFilters) {
    if (fetched !== null) {
      next = (
        fetched
          ? next.where(sql<SqlBool>`${sql.ref(column)} IS NOT NULL`)
          : next.where(sql<SqlBool>`${sql.ref(column)} IS NULL`)
      ) as T;
    }
  }
  return next;
}

export class GamesRepository {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(query: GamesQuery): GameListResult {
    const count = firstSync<{ count: number }>(
      this.db,
      withGameFilters(
        queryFor(this.db)
          .selectFrom("v_games")
          .select((expression) => expression.fn.countAll().as("count")),
        query,
      ).compile(),
    );
    const total = Number(count?.count ?? 0);

    let rowsQuery = withGameFilters(queryFor(this.db).selectFrom("v_games").selectAll(), query);
    for (const term of gameOrderTerms(query.sort, query.order)) {
      rowsQuery = rowsQuery.orderBy(term.expression, term.direction);
    }
    const rows = allSync<GamesRow>(
      this.db,
      rowsQuery
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
      meta: { dataAsOf: this.dataAsOf() },
    };
  }

  get(appId: number): GameDetail | null {
    const row = firstSync<GamesRow>(
      this.db,
      queryFor(this.db).selectFrom("v_games").selectAll().where("app_id", "=", appId).compile(),
    );
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
    return allSync<{ id: string; name: string; kind: string }>(
      this.db,
      queryFor(this.db)
        .selectFrom("steam_collections as c")
        .innerJoin("steam_collection_games as scg", "scg.steam_collection_id", "c.id")
        .select(["c.id as id", "c.name as name", "c.kind as kind"])
        .where("scg.app_id", "=", appId)
        .where("c.is_dynamic", "=", 0)
        .orderBy("c.name", "asc")
        .orderBy("c.id", "asc")
        .compile(),
    );
  }

  counts(): LibraryCounts {
    const row = firstSync<{ gameCount: number; installedCount: number }>(
      this.db,
      queryFor(this.db)
        .selectFrom("games")
        .select(sql<number>`COUNT(*)`.as("gameCount"))
        .select(
          sql<number>`COALESCE(SUM(CASE WHEN ${sql.ref("installed")} = 1 THEN 1 ELSE 0 END), 0)`.as(
            "installedCount",
          ),
        )
        .compile(),
    );
    return {
      gameCount: row?.gameCount ?? 0,
      installedCount: row?.installedCount ?? 0,
    };
  }

  ownershipCounts(): OwnershipCounts {
    const countFor = (status: "owned" | "local_only" | "unknown") =>
      sql<number>`COALESCE(SUM(CASE WHEN ${sql.ref("ownership_status")} = ${status} THEN 1 ELSE 0 END), 0)`;
    const row = firstSync<{ owned: number; localOnly: number; unknown: number }>(
      this.db,
      queryFor(this.db)
        .selectFrom("games")
        .select(countFor("owned").as("owned"))
        .select(countFor("local_only").as("localOnly"))
        .select(countFor("unknown").as("unknown"))
        .compile(),
    );
    return {
      owned: row?.owned ?? 0,
      localOnly: row?.localOnly ?? 0,
      unknown: row?.unknown ?? 0,
    };
  }

  scanState(): LibraryScanState {
    // A direct `library` run and the library phase of an `all` run both write
    // `source_state.steam_local`; the latest attempt is the latest scan.
    const row = firstSync<{ status: string; last_attempt_at: number | null }>(
      this.db,
      queryFor(this.db)
        .selectFrom("source_state")
        .select(["status", "last_attempt_at"])
        .where("name", "=", "steam_local")
        .compile(),
    );
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
