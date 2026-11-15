import type BetterSqlite3 from "better-sqlite3";
import { APP_VERSION, DB_SCHEMA_VERSION } from "../shared/app.ts";
import {
  SOURCE_ORDER,
  type SourceHealth,
  type Status,
  type SourceStatus,
} from "../shared/types.ts";
import { GamesRepository } from "./library/games.ts";
import { readActiveRefresh, readLastRefresh } from "./refresh/service.ts";
import type { SteamDiscovery } from "./steam/discovery.ts";

export interface BuildStatusInput {
  discovery: SteamDiscovery;
  steamApiKey: string | null;
  configuredSteamId64: string | null;
  schemaVersion?: number;
  version?: string;
  /** When provided, Library counts, scan state, and source health come from SQLite. */
  db?: BetterSqlite3.Database;
}

function toIso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
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
  const rows = db.prepare("SELECT * FROM source_state").all() as SourceRow[];
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
        account: input.discovery.account,
      },
      ownership: {
        state: ownershipConfigured ? "unknown" : "not_configured",
        gameCount: 0,
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

  return {
    app: {
      version: input.version ?? APP_VERSION,
      dbSchemaVersion: input.schemaVersion ?? DB_SCHEMA_VERSION,
    },
    steam: {
      state: input.discovery.state,
      root: input.discovery.root,
      account: input.discovery.account,
    },
    ownership: {
      state: ownershipConfigured ? "unknown" : "not_configured",
      gameCount: 0,
      lastSuccessAt: null,
      lastAttemptAt: null,
      error: null,
    },
    library: {
      gameCount: counts.gameCount,
      installedCount: counts.installedCount,
      lastScanAt: toIso(scan.lastScanAt),
      lastScanStatus: scan.lastScanStatus,
    },
    metadata: {
      tags: { ok: 0, missing: 0, stale: 0, error: 0 },
      store: { ok: 0, unavailable: 0, missing: 0, stale: 0, error: 0 },
      reviews: { ok: 0, unavailable: 0, missing: 0, stale: 0, error: 0 },
      lastSuccessAt: null,
    },
    sources: sourceHealth(input.db, ownershipConfigured),
    activeRefresh: readActiveRefresh(input.db),
    lastRefresh: readLastRefresh(input.db),
  };
}
