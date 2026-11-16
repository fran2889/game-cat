import type BetterSqlite3 from "better-sqlite3";
import { sql } from "kysely";
import type { ErrorDetail, RefreshMode, RefreshRun, RefreshScope } from "../../shared/types.ts";
import { allSync, firstSync, queryFor, runSync } from "../db/query.ts";
import { asRecord } from "../request.ts";
import { toIsoTimestamp as toIso } from "../timestamps.ts";
import { METADATA_SOURCE_NAMES } from "./sources.ts";
import { emptyCounters } from "./stats.ts";
import type { InternalMetadataStats, RefreshRow } from "./types.ts";

/**
 * Run and progress persistence (spec §4.2, §8.7).
 *
 * The worker owns when a write happens; this module owns the row shape and the
 * SQL. Phase modules report outcomes, never write run state directly except
 * through the documented progress helper.
 */

export function parseAppIds(raw: string | null): number[] | null {
  if (raw === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((entry): entry is number => Number.isSafeInteger(entry))
      : null;
  } catch {
    return null;
  }
}

function parseRawStats(raw: string | null): Record<string, unknown> | null {
  if (raw === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return asRecord(value);
  } catch {
    return null;
  }
}

/** Only the documented per-source counters cross the API boundary. */
function toApiStats(raw: string | null): RefreshRun["stats"] {
  const value = parseRawStats(raw);
  if (value === null) {
    return null;
  }
  const sources = value.sources;
  if (typeof sources !== "object" || sources === null) {
    return null;
  }
  const output: RefreshRun["stats"] = {
    sources: {
      steamspy: emptyCounters(),
      storefront: emptyCounters(),
      steam_reviews: emptyCounters(),
    },
  };
  for (const name of METADATA_SOURCE_NAMES) {
    const counters = (sources as Record<string, unknown>)[name];
    if (typeof counters !== "object" || counters === null) {
      continue;
    }
    const record = counters as Record<string, unknown>;
    output.sources[name] = {
      candidates: nonNegativeInteger(record.candidates),
      done: nonNegativeInteger(record.done),
      failed: nonNegativeInteger(record.failed),
      skipped: nonNegativeInteger(record.skipped),
    };
  }
  return output;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function lastProgressAt(raw: string | null): number | null {
  const value = parseRawStats(raw)?.lastProgressAt;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function toRefreshRun(row: RefreshRow): RefreshRun {
  const error: ErrorDetail | null =
    row.error_code === null
      ? null
      : {
          code: row.error_code,
          message: row.error_message ?? "The Refresh run failed.",
        };
  return {
    id: String(row.id),
    scope: row.scope,
    mode: row.mode,
    status: row.status,
    startedAt: toIso(row.started_at) ?? "",
    finishedAt: toIso(row.finished_at),
    total: row.total,
    done: row.done,
    appIds: parseAppIds(row.app_ids_json),
    // §4.2: stats is null for library and ownership runs, and only the
    // whitelisted source counters are exposed.
    stats: row.scope === "library" || row.scope === "ownership" ? null : toApiStats(row.stats_json),
    error,
  };
}

export function readRefreshRun(db: BetterSqlite3.Database, id: number): RefreshRun | null {
  const row = readRunRow(db, id);
  return row === undefined ? null : toRefreshRun(row);
}

export function readLastRefresh(db: BetterSqlite3.Database): RefreshRun | null {
  const row = firstSync<RefreshRow>(
    db,
    queryFor(db).selectFrom("refresh_runs").selectAll().orderBy("id", "desc").limit(1).compile(),
  );
  return row === undefined ? null : toRefreshRun(row);
}

export function readActiveRefresh(db: BetterSqlite3.Database): RefreshRun | null {
  const row = readActiveRunRow(db);
  return row === undefined ? null : toRefreshRun(row);
}

export function readRunRow(db: BetterSqlite3.Database, id: number): RefreshRow | undefined {
  return firstSync<RefreshRow>(
    db,
    queryFor(db).selectFrom("refresh_runs").selectAll().where("id", "=", id).compile(),
  );
}

export function readActiveRunRow(db: BetterSqlite3.Database): RefreshRow | undefined {
  return firstSync<RefreshRow>(
    db,
    queryFor(db)
      .selectFrom("refresh_runs")
      .selectAll()
      .where("status", "in", ["queued", "running"])
      .orderBy("id", "desc")
      .limit(1)
      .compile(),
  );
}

export function readNextQueuedRun(db: BetterSqlite3.Database): RefreshRow | undefined {
  return firstSync<RefreshRow>(
    db,
    queryFor(db)
      .selectFrom("refresh_runs")
      .selectAll()
      .where("status", "=", "queued")
      .orderBy("id", "asc")
      .limit(1)
      .compile(),
  );
}

export function hasQueuedRun(db: BetterSqlite3.Database): boolean {
  return (
    firstSync(
      db,
      queryFor(db)
        .selectFrom("refresh_runs")
        .select(sql<number>`1`.as("queued"))
        .where("status", "=", "queued")
        .limit(1)
        .compile(),
    ) !== undefined
  );
}

export interface QueuedRun {
  scope: RefreshScope;
  mode: RefreshMode | null;
  appIds: number[] | null;
  steamId64: string | null;
  startedAt: number;
}

export function insertQueuedRun(db: BetterSqlite3.Database, run: QueuedRun): number {
  const info = runSync(
    db,
    queryFor(db)
      .insertInto("refresh_runs")
      .values({
        scope: run.scope,
        mode: run.mode,
        status: "queued",
        steam_id64: run.steamId64,
        started_at: run.startedAt,
        done: 0,
        app_ids_json: run.appIds === null ? null : JSON.stringify(run.appIds),
      })
      .compile(),
  );
  return Number(info.lastInsertRowid);
}

export function markRunRunning(db: BetterSqlite3.Database, id: number): void {
  runSync(
    db,
    queryFor(db)
      .updateTable("refresh_runs")
      .set({ status: "running" })
      .where("id", "=", id)
      .compile(),
  );
}

export interface RunOutcome {
  status: "succeeded" | "partial" | "failed";
  total: number | null;
  done: number;
  stats: string | null;
  error: ErrorDetail | null;
}

export function finishRun(
  db: BetterSqlite3.Database,
  id: number,
  outcome: RunOutcome,
  finishedAt: number,
): void {
  runSync(
    db,
    queryFor(db)
      .updateTable("refresh_runs")
      .set({
        status: outcome.status,
        finished_at: finishedAt,
        total: outcome.total,
        done: outcome.done,
        stats_json: sql<string | null>`COALESCE(${outcome.stats}, stats_json)`,
        error_code: outcome.error?.code ?? null,
        error_message: outcome.error?.message ?? null,
      })
      .where("id", "=", id)
      .compile(),
  );
}

export interface RunProgress {
  total: number;
  done: number;
  stats: InternalMetadataStats;
}

/** Progress is the only run-state write a phase may make. */
export function writeProgress(
  db: BetterSqlite3.Database,
  runId: number,
  progress: RunProgress,
): void {
  runSync(
    db,
    queryFor(db)
      .updateTable("refresh_runs")
      .set({
        total: progress.total,
        done: progress.done,
        stats_json: JSON.stringify(progress.stats),
      })
      .where("id", "=", runId)
      .compile(),
  );
}

/**
 * Mark an active run `INTERRUPTED` at its last progress point. The caller has
 * already aborted upstream work and still owes the worker unwind.
 */
export function interruptRun(
  db: BetterSqlite3.Database,
  row: RefreshRow,
  now: number,
  message: string,
): void {
  runSync(
    db,
    queryFor(db)
      .updateTable("refresh_runs")
      .set({
        status: "failed",
        finished_at: lastProgressAt(row.stats_json) ?? now,
        error_code: "INTERRUPTED",
        error_message: message,
      })
      .where("id", "=", row.id)
      .where("status", "in", ["queued", "running"])
      .compile(),
  );
}

/**
 * Startup recovery (§8.7): no run survives a restart as `queued` or `running`.
 * Completed per-Game and per-source rows are untouched.
 */
export function recoverInterruptedRuns(db: BetterSqlite3.Database, now: number): number {
  const rows = allSync<RefreshRow>(
    db,
    queryFor(db)
      .selectFrom("refresh_runs")
      .selectAll()
      .where("status", "in", ["queued", "running"])
      .compile(),
  );
  if (rows.length === 0) {
    return 0;
  }
  const message = "The Refresh run was interrupted. The next Fetch resumes pending work.";
  db.transaction(() => {
    for (const row of rows) {
      runSync(
        db,
        queryFor(db)
          .updateTable("refresh_runs")
          .set({
            status: "failed",
            finished_at: lastProgressAt(row.stats_json) ?? now,
            error_code: "INTERRUPTED",
            error_message: message,
          })
          .where("id", "=", row.id)
          .compile(),
      );
    }
  })();
  return rows.length;
}
