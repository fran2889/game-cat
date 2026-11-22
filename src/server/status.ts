import type BetterSqlite3 from "better-sqlite3";
import { sql } from "kysely";
import { allSync, firstSync, queryFor } from "./db/query.ts";
import { APP_VERSION, DB_SCHEMA_VERSION } from "../shared/app.ts";
import {
  METADATA_SOURCE_NAMES,
  SOURCE_ORDER,
  type ErrorDetail,
  type OwnershipState,
  type SourceHealth,
  type Status,
  type SourceStatus,
} from "../shared/types.ts";
import { GamesRepository, type OwnershipCounts } from "./library/games.ts";
import { readActiveRefresh, readLastRefresh } from "./refresh/service.ts";
import type { SteamDiscovery } from "./steam/discovery.ts";
import { toIsoTimestamp as toIso } from "./timestamps.ts";

export interface BuildStatusInput {
  discovery: SteamDiscovery;
  steamApiKey: string | null;
  configuredSteamId64: string | null;
  schemaVersion?: number;
  version?: string;
  /** When provided, Library counts, scan state, and source health come from SQLite. */
  db?: BetterSqlite3.Database;
}

interface SourceRow {
  name: string;
  status: SourceStatus;
  last_success_at: number | null;
  last_attempt_at: number | null;
  retry_after_at: number | null;
  last_error: string | null;
}

function sourceHealth(db: BetterSqlite3.Database, ownershipConfigured: boolean): SourceHealth[] {
  const rows = allSync<SourceRow>(
    db,
    queryFor(db).selectFrom("source_state").selectAll().compile(),
  );
  const byName = new Map(rows.map((row) => [row.name, row]));
  return SOURCE_ORDER.map((name) => {
    const row = byName.get(name);
    const status =
      name === "steam_web_api" &&
      !ownershipConfigured &&
      (row === undefined || row.status === "unknown")
        ? "not_configured"
        : (row?.status ?? "unknown");
    return {
      name,
      status,
      lastSuccessAt: toIso(row?.last_success_at ?? null),
      lastAttemptAt: toIso(row?.last_attempt_at ?? null),
      retryAfterAt: toIso(row?.retry_after_at ?? null),
      lastError: row?.last_error ?? null,
    };
  });
}

const OWNERSHIP_STATES: readonly OwnershipState[] = [
  "unknown",
  "ok",
  "partial",
  "empty",
  "not_configured",
  "invalid_key",
  "rate_limited",
  "error",
];

interface OwnershipStateRow {
  status: SourceStatus;
  last_success_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
}

/** Map a persisted ownership source failure to the documented ErrorDetail code. */
const OWNERSHIP_ERROR_CODES: Partial<Record<SourceStatus, string>> = {
  invalid_key: "INVALID_KEY",
  rate_limited: "RATE_LIMITED",
  error: "OWNERSHIP_REQUEST_FAILED",
  partial: "OWNERSHIP_PARTIAL",
};

function ownershipState(status: SourceStatus | undefined): OwnershipState {
  return status !== undefined && (OWNERSHIP_STATES as readonly string[]).includes(status)
    ? (status as OwnershipState)
    : "unknown";
}

/**
 * The last ownership failure from either an `ownership` run or the ownership
 * phase of an `all` run. Both phases write `source_state.steam_web_api`, so the
 * latest safe message and status are the source of truth.
 */
function ownershipError(db: BetterSqlite3.Database): ErrorDetail | null {
  const row = firstSync<{ status: SourceStatus; last_error: string | null }>(
    db,
    queryFor(db)
      .selectFrom("source_state")
      .select(["status as status", "last_error as last_error"])
      .where("name", "=", "steam_web_api")
      .compile(),
  );
  if (row === undefined || row.last_error === null) {
    return null;
  }
  return {
    code: OWNERSHIP_ERROR_CODES[row.status] ?? "OWNERSHIP_REQUEST_FAILED",
    message: row.last_error,
  };
}

function ownershipStatus(
  db: BetterSqlite3.Database,
  configured: boolean,
): {
  state: OwnershipState;
  counts: OwnershipCounts;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  error: ErrorDetail | null;
} {
  const row = firstSync<OwnershipStateRow>(
    db,
    queryFor(db)
      .selectFrom("source_state")
      .select([
        "status as status",
        "last_success_at as last_success_at",
        "last_attempt_at as last_attempt_at",
        "last_error as last_error",
      ])
      .where("name", "=", "steam_web_api")
      .compile(),
  );
  const state =
    row === undefined || row.status === "unknown"
      ? configured
        ? "unknown"
        : "not_configured"
      : ownershipState(row.status);
  const counts = new GamesRepository(db).ownershipCounts();
  return {
    state,
    counts,
    lastSuccessAt: toIso(row?.last_success_at ?? null),
    lastAttemptAt: toIso(row?.last_attempt_at ?? null),
    error: ownershipError(db),
  };
}

type TagsCounts = Status["metadata"]["tags"];
type StoreCounts = Status["metadata"]["store"];
type ReviewCounts = Status["metadata"]["reviews"];

function countRows(
  db: BetterSqlite3.Database,
  rows: Array<{ status: string; count: number }>,
  allowed: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of allowed) {
    counts[status] = 0;
  }
  for (const row of rows) {
    if ((allowed as readonly string[]).includes(row.status)) {
      counts[row.status] = row.count;
    }
  }
  return counts;
}

/**
 * `Status.metadata` classifies every Game exactly once per source (AC-M16). A
 * Game with no source row is `missing`; the LEFT JOIN keeps those counted.
 */
function metadataState(db: BetterSqlite3.Database): Status["metadata"] {
  const tags = countRows(
    db,
    allSync(
      db,
      queryFor(db)
        .selectFrom("games as g")
        .leftJoin("steamspy_appdetails as s", "s.app_id", "g.app_id")
        .select(sql<string>`COALESCE(s.tags_status, 'missing')`.as("status"))
        .select(sql<number>`COUNT(*)`.as("count"))
        .groupBy(sql`COALESCE(s.tags_status, 'missing')`)
        .compile(),
    ),
    ["ok", "missing", "stale", "error"],
  ) as TagsCounts;
  const store = countRows(
    db,
    allSync(
      db,
      queryFor(db)
        .selectFrom("games as g")
        .leftJoin("storefront_appdetails as s", "s.app_id", "g.app_id")
        .select(sql<string>`COALESCE(s.store_status, 'missing')`.as("status"))
        .select(sql<number>`COUNT(*)`.as("count"))
        .groupBy(sql`COALESCE(s.store_status, 'missing')`)
        .compile(),
    ),
    ["ok", "unavailable", "missing", "stale", "error"],
  ) as StoreCounts;
  const reviews = countRows(
    db,
    allSync(
      db,
      queryFor(db)
        .selectFrom("games as g")
        .leftJoin("steam_review_summaries as s", "s.app_id", "g.app_id")
        .select(sql<string>`COALESCE(s.review_status, 'missing')`.as("status"))
        .select(sql<number>`COUNT(*)`.as("count"))
        .groupBy(sql`COALESCE(s.review_status, 'missing')`)
        .compile(),
    ),
    ["ok", "unavailable", "missing", "stale", "error"],
  ) as ReviewCounts;
  const row = firstSync<{ last_success_at: number | null }>(
    db,
    queryFor(db)
      .selectFrom("source_state")
      .select(sql<number | null>`MAX(last_success_at)`.as("last_success_at"))
      .where("name", "in", METADATA_SOURCE_NAMES)
      .compile(),
  );
  return { tags, store, reviews, lastSuccessAt: toIso(row?.last_success_at ?? null) };
}

/**
 * The Status document. With a database it reports real Library counts, the last
 * local scan, source health, and Refresh-run state; without one it reports the
 * empty walking-skeleton shape (used by the early startup tests).
 */
export function buildStatus(input: BuildStatusInput): Status {
  const steamId64 = input.discovery.account?.steamId64 ?? input.configuredSteamId64 ?? null;
  const ownershipConfigured = input.steamApiKey !== null && steamId64 !== null;

  if (input.db === undefined) {
    const sources: SourceHealth[] = SOURCE_ORDER.map((name) => ({
      name,
      status: name === "steam_web_api" && !ownershipConfigured ? "not_configured" : "unknown",
      lastSuccessAt: null,
      lastAttemptAt: null,
      retryAfterAt: null,
      lastError: null,
    }));

    return {
      app: {
        version: input.version ?? APP_VERSION,
        dbSchemaVersion: input.schemaVersion ?? DB_SCHEMA_VERSION,
      },
      steam: {
        state: input.discovery.state,
        root: input.discovery.root,
        ambiguous: input.discovery.ambiguous,
        account: input.discovery.account,
      },
      ownership: {
        state: ownershipConfigured ? "unknown" : "not_configured",
        gameCount: 0,
        counts: { owned: 0, localOnly: 0, unknown: 0 },
        lastSuccessAt: null,
        lastAttemptAt: null,
        error: null,
      },
      library: {
        gameCount: 0,
        installedCount: 0,
        lastScanAt: null,
        lastScanStatus: "never",
      },
      metadata: {
        tags: { ok: 0, missing: 0, stale: 0, error: 0 },
        store: { ok: 0, unavailable: 0, missing: 0, stale: 0, error: 0 },
        reviews: { ok: 0, unavailable: 0, missing: 0, stale: 0, error: 0 },
        lastSuccessAt: null,
      },
      sources,
      activeRefresh: null,
      lastRefresh: null,
    };
  }

  const games = new GamesRepository(input.db);
  const counts = games.counts();
  const scan = games.scanState();
  const ownership = ownershipStatus(input.db, ownershipConfigured);

  return {
    app: {
      version: input.version ?? APP_VERSION,
      dbSchemaVersion: input.schemaVersion ?? DB_SCHEMA_VERSION,
    },
    steam: {
      state: input.discovery.state,
      root: input.discovery.root,
      ambiguous: input.discovery.ambiguous,
      account: input.discovery.account,
    },
    ownership: {
      ...ownership,
      gameCount: ownership.counts.owned,
    },
    library: {
      gameCount: counts.gameCount,
      installedCount: counts.installedCount,
      lastScanAt: toIso(scan.lastScanAt),
      lastScanStatus: scan.lastScanStatus,
    },
    metadata: metadataState(input.db),
    sources: sourceHealth(input.db, ownershipConfigured),
    activeRefresh: readActiveRefresh(input.db),
    lastRefresh: readLastRefresh(input.db),
  };
}
