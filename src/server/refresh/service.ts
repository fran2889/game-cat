import type BetterSqlite3 from "better-sqlite3";
import type {
  ErrorDetail,
  RefreshMode,
  RefreshRun,
  RefreshScope,
  RefreshStatus,
  SourceStatus,
} from "../../shared/types.ts";
import { MAX_REFRESH_APP_IDS } from "../../shared/types.ts";
import { readBoundSteamId64 } from "../db/database.ts";
import { HttpError } from "../errors.ts";
import { asRecord, validationError } from "../request.ts";
import {
  AccountMismatchError,
  bindAccount,
  scanLocalLibrary,
  type LibraryScanResult,
} from "../library/scan.ts";
import {
  createSteamOwnershipSource,
  type OwnershipFetchResult,
  type SteamOwnershipSource,
} from "../steam/ownership.ts";
import { applyOwnershipRoster } from "./ownership.ts";
import {
  METADATA_SOURCE_NAMES,
  MetadataSourceRegistry,
  type MetadataSource,
  type MetadataSourceName,
  type MetadataSourceOutcome,
} from "./sources.ts";
import { toIsoTimestamp as toIso } from "../timestamps.ts";

/**
 * The general Refresh engine (spec §2.6, §4.3, §6.2-§6.4, §8.7).
 *
 * `start` validates, deduplicates, creates a `queued` run, and returns. A
 * single in-process worker then executes one run at a time. Library scans and
 * ownership refreshes finish in their phases; Metadata runs select work per
 * `(Game, source)` and execute registered adapters.
 */

interface RefreshRow {
  id: number;
  scope: RefreshScope;
  mode: RefreshMode | null;
  status: RefreshStatus;
  steam_id64: string | null;
  started_at: number;
  finished_at: number | null;
  total: number | null;
  done: number;
  app_ids_json: string | null;
  error_code: string | null;
  error_message: string | null;
  stats_json: string | null;
}

interface RefreshRequest {
  scope: RefreshScope;
  mode: RefreshMode | null;
  appIds: number[] | null;
}

/** The settings a run uses. A run keeps the snapshot it started with. */
interface RunConfig {
  steamRoot: string | null;
  steamId64: string | null;
  steamApiKey: string | null;
}

export interface RefreshConfigUpdate {
  steamRoot?: string | null;
  steamId64?: string | null;
  steamApiKey?: string | null;
}

export interface RefreshStartResult {
  run: RefreshRun;
  deduplicated: boolean;
}

export interface RefreshServiceOptions {
  db: BetterSqlite3.Database;
  steamRoot: string | null;
  steamId64: string | null;
  /** Server-side only. Never logged, stored, or returned. */
  steamApiKey?: string | null;
  now?: () => number;
  /** Monotonic milliseconds for request pacing. Tests pair it with `sleep`. */
  nowMs?: () => number;
  scan?: typeof scanLocalLibrary;
  /** Injectable ownership adapter. Tests use a fake; production builds one from the key. */
  ownershipSource?: SteamOwnershipSource;
  /** Metadata adapters. Empty until #28-#30 register real sources. */
  sources?: MetadataSourceRegistry | readonly MetadataSource[];
  /** Full-jitter source. Tests pass a deterministic value. */
  jitter?: () => number;
  /** Retry delay seam. Fake clocks advance time and resolve immediately. */
  sleep?: (milliseconds: number) => Promise<void>;
  onWarn?: (message: string, details: Record<string, unknown>) => void;
}

type CounterName = "candidates" | "done" | "failed" | "skipped";
type SourceCounters = Record<CounterName, number>;

interface InternalMetadataStats {
  sources: Record<MetadataSourceName, SourceCounters>;
  lastProgressAt: number;
}

interface PhaseError {
  error: ErrorDetail | null;
  partial: boolean;
  fatal: boolean;
}

/** A shared-host pause: skipped passes inherit the reason that caused it. */
interface HostPause {
  until: number;
  reason: "rate_limited" | "blocked";
}

interface LibraryPhaseResult extends PhaseError {
  status: "succeeded" | "partial" | "failed";
  result: LibraryScanResult;
}

interface OwnershipPhaseResult extends PhaseError {
  status: "succeeded" | "partial" | "failed" | "skipped";
  total: number | null;
  done: number;
}

interface MetadataPhaseResult extends PhaseError {
  total: number;
  done: number;
  stats: InternalMetadataStats;
}

interface WorkItem {
  appId: number;
  name: string;
}

interface SelectionPlan {
  total: number;
  items: Map<MetadataSourceName, WorkItem[]>;
  /** App IDs in a Full Refresh that no longer have a Game row. */
  missingAppIds: number[];
  remainingByGame: Map<number, number>;
  done: number;
  stats: InternalMetadataStats;
  partial: boolean;
}

const MAX_ATTEMPTS = 5;
const CIRCUIT_FAILURES = 5;
const BLOCK_SECONDS = 15 * 60;
const PROGRESS_INTERVAL = 25;
/**
 * Serial request pacing from §6.1: SteamSpy is about one request/second.
 * Storefront and reviews use separate hosts and each gets a 1.5-second
 * interval. The first request for a host is never delayed.
 */
const PACING_MS: Record<string, number> = {
  steamspy: 1_000,
  store: 1_500,
  steam_web_api: 1_500,
};

/** Per-Game rows used to select pending work and to reconcile `source_state`. */
const SOURCE_ROW_QUERIES: Record<MetadataSourceName, string> = {
  steamspy:
    "SELECT app_id, tags_status AS status, tags_fetched_at AS fetched_at, updated_at FROM steamspy_appdetails",
  storefront:
    "SELECT app_id, store_status AS status, store_fetched_at AS fetched_at, updated_at FROM storefront_appdetails",
  steam_reviews:
    "SELECT app_id, review_status AS status, review_fetched_at AS fetched_at, updated_at FROM steam_review_summaries",
};

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function emptyCounters(): SourceCounters {
  return { candidates: 0, done: 0, failed: 0, skipped: 0 };
}

function emptyInternalStats(): InternalMetadataStats {
  return {
    sources: {
      steamspy: emptyCounters(),
      storefront: emptyCounters(),
      steam_reviews: emptyCounters(),
    },
    lastProgressAt: 0,
  };
}

function parseAppIds(raw: string | null): number[] | null {
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
  const row = db.prepare("SELECT * FROM refresh_runs WHERE id = ?").get(id) as
    RefreshRow | undefined;
  return row === undefined ? null : toRefreshRun(row);
}

export function readLastRefresh(db: BetterSqlite3.Database): RefreshRun | null {
  const row = db.prepare("SELECT * FROM refresh_runs ORDER BY id DESC LIMIT 1").get() as
    RefreshRow | undefined;
  return row === undefined ? null : toRefreshRun(row);
}

export function readActiveRefresh(db: BetterSqlite3.Database): RefreshRun | null {
  const row = db
    .prepare(
      "SELECT * FROM refresh_runs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1",
    )
    .get() as RefreshRow | undefined;
  return row === undefined ? null : toRefreshRun(row);
}

const OWNERSHIP_RUN_ERRORS: Record<
  Exclude<OwnershipFetchResult["kind"], "complete" | "empty" | "partial">,
  {
    code: string;
    status: "partial";
    sourceStatus: "invalid_key" | "rate_limited" | "error";
  }
> = {
  invalid_key: { code: "INVALID_KEY", status: "partial", sourceStatus: "invalid_key" },
  rate_limited: { code: "RATE_LIMITED", status: "partial", sourceStatus: "rate_limited" },
  error: { code: "OWNERSHIP_REQUEST_FAILED", status: "partial", sourceStatus: "error" },
};

function requestIdentity(scope: RefreshScope, mode: RefreshMode | null, appIds: number[] | null) {
  return JSON.stringify([scope, mode, appIds]);
}

function rowIdentity(row: RefreshRow): string {
  return requestIdentity(row.scope, row.mode, parseAppIds(row.app_ids_json));
}

function isMetadataPending(status: string | undefined, fetchedAt: number | null): boolean {
  if (status === undefined) {
    // No row for this source.
    return true;
  }
  if (status === "ok" || status === "unavailable") {
    return false;
  }
  if (status === "missing") {
    // A never-attempted miss is pending; a settled miss is not.
    return fetchedAt === null;
  }
  // `stale` and `error` are retried.
  return true;
}

function validateAppIds(value: unknown): { appIds: number[] | null; error: string | null } {
  if (!Array.isArray(value)) {
    return { appIds: null, error: "must be an array of App IDs" };
  }
  if (value.length === 0) {
    return { appIds: null, error: "must contain at least one App ID" };
  }
  if (value.length > MAX_REFRESH_APP_IDS) {
    return { appIds: null, error: `must contain at most ${MAX_REFRESH_APP_IDS} App IDs` };
  }
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      return { appIds: null, error: "must contain positive integers" };
    }
    if (seen.has(entry)) {
      return { appIds: null, error: "must not contain duplicates" };
    }
    seen.add(entry);
  }
  return { appIds: [...seen].sort((left, right) => left - right), error: null };
}

function parseRefreshRequest(body: unknown): RefreshRequest {
  const record = asRecord(body);
  if (record === null) {
    throw validationError({ body: "must be an object" }, "body");
  }
  const fieldErrors: Record<string, string> = {};

  const scope = record.scope;
  if (scope === undefined) {
    fieldErrors.scope = "is required";
  } else if (typeof scope !== "string") {
    fieldErrors.scope = "must be a string";
  } else if (
    scope !== "library" &&
    scope !== "ownership" &&
    scope !== "metadata" &&
    scope !== "all"
  ) {
    fieldErrors.scope = "must be library, ownership, metadata, or all";
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw validationError(fieldErrors, "body");
  }

  const validScope = scope as RefreshScope;
  const rawMode = record.mode;
  const modeProvided = rawMode !== undefined;
  let mode: RefreshMode | null = null;

  if (validScope === "library" || validScope === "ownership") {
    if (modeProvided) {
      fieldErrors.mode = `${validScope} runs do not accept a mode`;
    }
  } else if (validScope === "all") {
    if (!modeProvided) {
      fieldErrors.mode = "is required";
    } else if (rawMode !== "fetch") {
      fieldErrors.mode = "all runs require mode fetch";
    } else {
      mode = "fetch";
    }
  } else {
    if (!modeProvided) {
      fieldErrors.mode = "is required";
    } else if (rawMode !== "fetch" && rawMode !== "full") {
      fieldErrors.mode = "must be fetch or full";
    } else {
      mode = rawMode;
    }
  }

  const rawAppIds = record.appIds;
  // An explicit `null` is not a valid selection for any scope; only an omitted
  // key is "not provided".
  const appIdsProvided = rawAppIds !== undefined;
  let appIds: number[] | null = null;
  if (validScope === "metadata" && mode === "full") {
    if (rawAppIds === undefined || rawAppIds === null) {
      fieldErrors.appIds = "is required for a full Refresh";
    } else {
      const parsed = validateAppIds(rawAppIds);
      if (parsed.error !== null) {
        fieldErrors.appIds = parsed.error;
      } else {
        appIds = parsed.appIds;
      }
    }
  } else if (appIdsProvided) {
    fieldErrors.appIds =
      validScope === "metadata"
        ? "is only valid with mode full"
        : `${validScope} runs do not accept appIds`;
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw validationError(fieldErrors, "body");
  }

  return {
    scope: validScope,
    mode: validScope === "library" || validScope === "ownership" ? null : mode,
    appIds,
  };
}

export class RefreshService {
  private readonly db: BetterSqlite3.Database;
  private readonly now: () => number;
  private readonly nowMs: () => number;
  private readonly jitter: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly sources: MetadataSourceRegistry;
  /** Aborted on shutdown so upstream requests and backoff waits stop promptly. */
  private readonly stopController = new AbortController();
  private worker: Promise<void> | null = null;
  private stopping = false;
  /** Live settings for the next run; an in-flight run uses its snapshot. */
  private currentConfig: RunConfig;
  private readonly runConfigs = new Map<number, RunConfig>();

  constructor(private readonly options: RefreshServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? unixSeconds;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.jitter = options.jitter ?? Math.random;
    this.sleep = options.sleep ?? ((milliseconds) => this.sleepUnlessStopped(milliseconds));
    this.sources =
      options.sources instanceof MetadataSourceRegistry
        ? options.sources
        : new MetadataSourceRegistry(options.sources ?? []);
    this.currentConfig = {
      steamRoot: options.steamRoot,
      steamId64: options.steamId64,
      steamApiKey: options.steamApiKey ?? null,
    };
  }

  /** Apply settings written through `PATCH /api/config` to the next run. */
  applyConfig(update: RefreshConfigUpdate): void {
    if (update.steamRoot !== undefined) {
      this.currentConfig.steamRoot = update.steamRoot;
    }
    if (update.steamId64 !== undefined) {
      this.currentConfig.steamId64 = update.steamId64;
    }
    if (update.steamApiKey !== undefined) {
      this.currentConfig.steamApiKey = update.steamApiKey;
    }
  }

  /** Validate and enqueue a documented run. Execution continues in the background. */
  async start(body: unknown): Promise<RefreshStartResult> {
    const request = parseRefreshRequest(body);
    if (request.scope === "ownership") {
      this.assertOwnershipConfigured();
    }

    const running = this.readActiveRow();
    if (running !== undefined) {
      if (rowIdentity(running) === requestIdentity(request.scope, request.mode, request.appIds)) {
        return { run: toRefreshRun(running), deduplicated: true };
      }
      throw new HttpError(
        409,
        "REFRESH_IN_PROGRESS",
        "Another Refresh run is already in progress.",
        {
          details: {
            runId: String(running.id),
            scope: running.scope,
            mode: running.mode,
          },
        },
      );
    }

    const startedAt = this.now();
    const steamId64 = this.steamIdForRun(request.scope);
    const info = this.db
      .prepare(
        `INSERT INTO refresh_runs
           (scope, mode, status, steam_id64, started_at, done, app_ids_json)
         VALUES (?, ?, 'queued', ?, ?, 0, ?)`,
      )
      .run(
        request.scope,
        request.mode,
        steamId64,
        startedAt,
        request.appIds === null ? null : JSON.stringify(request.appIds),
      );
    const id = Number(info.lastInsertRowid);
    this.runConfigs.set(id, { ...this.currentConfig });
    this.enqueue();
    return { run: readRefreshRun(this.db, id)!, deduplicated: false };
  }

  get(id: number): RefreshRun | null {
    return readRefreshRun(this.db, id);
  }

  /** Resolve when the single worker has no queued or running work. */
  async waitForIdle(): Promise<void> {
    while (this.worker !== null) {
      await this.worker;
    }
  }

  /**
   * Startup recovery (§8.7): no run survives a restart as `queued` or
   * `running`. Completed per-Game and per-source rows are untouched.
   */
  recoverInterruptedRuns(): number {
    const rows = this.db
      .prepare("SELECT * FROM refresh_runs WHERE status IN ('queued', 'running')")
      .all() as RefreshRow[];
    if (rows.length === 0) {
      return 0;
    }
    const now = this.now();
    const update = this.db.prepare(
      `UPDATE refresh_runs SET
         status = 'failed',
         finished_at = ?,
         error_code = 'INTERRUPTED',
         error_message = ?
       WHERE id = ?`,
    );
    const message = "The Refresh run was interrupted. The next Fetch resumes pending work.";
    this.db.transaction(() => {
      for (const row of rows) {
        update.run(lastProgressAt(row.stats_json) ?? now, message, row.id);
      }
    })();
    return rows.length;
  }

  /**
   * Graceful shutdown (§8.9): mark the active run immediately, then let the
   * worker observe the stop flag and unwind without finishing the run.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    this.stopController.abort();
    const row = this.readActiveRow();
    if (row !== undefined) {
      const message = "The Refresh run was interrupted by shutdown.";
      this.db
        .prepare(
          `UPDATE refresh_runs SET
             status = 'failed',
             finished_at = ?,
             error_code = 'INTERRUPTED',
             error_message = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(lastProgressAt(row.stats_json) ?? this.now(), message, row.id);
    }
    if (this.worker !== null) {
      await this.worker;
    }
  }

  /** Backoff that never delays a graceful shutdown for up to a minute. */
  private sleepUnlessStopped(milliseconds: number): Promise<void> {
    if (this.stopping || this.stopController.signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.stopController.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      this.stopController.signal.addEventListener("abort", finish, { once: true });
    });
  }

  /**
   * Serial per-host pacing (§6.1). The map holds the last request time in
   * milliseconds; the first request for a host is not delayed. Tests inject a
   * fake clock through `sleep` and `nowMs`, so no suite actually waits.
   */
  private async pace(pacingKey: string, lastRequestAt: Map<string, number>): Promise<void> {
    const intervalMs = PACING_MS[pacingKey] ?? 0;
    if (intervalMs <= 0) {
      return;
    }
    const last = lastRequestAt.get(pacingKey);
    if (last === undefined) {
      return;
    }
    const waitMs = Math.ceil(last + intervalMs - this.nowMs());
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
  }

  private steamIdForRun(scope: RefreshScope): string | null {
    const bound = readBoundSteamId64(this.db);
    if (scope === "metadata") {
      return bound;
    }
    if (scope === "all") {
      return (
        bound ??
        (this.ownershipConfigured(this.currentConfig) ? this.currentConfig.steamId64 : null)
      );
    }
    return bound ?? this.currentConfig.steamId64;
  }

  private readActiveRow(): RefreshRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM refresh_runs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1",
      )
      .get() as RefreshRow | undefined;
  }

  private enqueue(): void {
    if (this.worker !== null || this.stopping) {
      return;
    }
    this.worker = Promise.resolve()
      .then(() => this.drain())
      .catch((error: unknown) => {
        this.options.onWarn?.("The Refresh worker failed.", {
          error: (error as Error).message,
        });
      })
      .finally(() => {
        this.worker = null;
        if (!this.stopping && this.hasQueued()) {
          this.enqueue();
        }
      });
  }

  private hasQueued(): boolean {
    return (
      this.db
        .prepare("SELECT 1 AS queued FROM refresh_runs WHERE status = 'queued' LIMIT 1")
        .get() !== undefined
    );
  }

  private async drain(): Promise<void> {
    while (!this.stopping) {
      const row = this.db
        .prepare("SELECT * FROM refresh_runs WHERE status = 'queued' ORDER BY id ASC LIMIT 1")
        .get() as RefreshRow | undefined;
      if (row === undefined) {
        return;
      }
      this.db.prepare("UPDATE refresh_runs SET status = 'running' WHERE id = ?").run(row.id);
      const running = { ...row, status: "running" as const };
      try {
        await this.execute(running);
      } catch (error) {
        if (!this.stopping) {
          this.finishRun(row.id, {
            status: "failed",
            total: row.total,
            done: row.done,
            stats:
              row.scope === "library" || row.scope === "ownership"
                ? null
                : (row.stats_json ?? JSON.stringify(emptyInternalStats())),
            error: {
              code: "INTERNAL_ERROR",
              message: `The Refresh run failed: ${(error as Error).message}`,
            },
          });
        }
      } finally {
        this.runConfigs.delete(row.id);
      }
    }
  }

  private async execute(row: RefreshRow): Promise<void> {
    const config = this.runConfigs.get(row.id) ?? this.currentConfig;
    switch (row.scope) {
      case "library":
        await this.executeLibrary(row, config);
        return;
      case "ownership":
        await this.executeOwnership(row, config);
        return;
      case "metadata":
        await this.executeMetadata(row);
        return;
      case "all":
        await this.executeAll(row, config);
        return;
    }
  }

  private assertOwnershipConfigured(): void {
    const missing: string[] = [];
    if (this.currentConfig.steamApiKey === null) {
      missing.push("webApiKey");
    }
    if (this.currentConfig.steamId64 === null) {
      missing.push("steamId64");
    }
    if (missing.length > 0) {
      throw new HttpError(
        409,
        "OWNERSHIP_NOT_CONFIGURED",
        "Ownership cannot be refreshed until the Web API key and Steam Account are configured.",
        { details: { missing } },
      );
    }
  }

  private ownershipConfigured(config: RunConfig): boolean {
    return config.steamApiKey !== null && config.steamId64 !== null;
  }

  private async executeLibrary(row: RefreshRow, config: RunConfig): Promise<void> {
    const phase = this.performLibraryPhase(config);
    if (this.stopping) {
      return;
    }
    this.finishRun(row.id, {
      status: phase.status,
      total: phase.result.stats.upserted,
      done: phase.result.stats.upserted,
      stats: JSON.stringify({
        ...phase.result.stats,
        ...(phase.result.skipped === null ? {} : { skipped: phase.result.skipped }),
      }),
      error: phase.error,
    });
  }

  private performLibraryPhase(config: RunConfig): LibraryPhaseResult {
    let result: LibraryScanResult;
    try {
      const scan = this.options.scan ?? scanLocalLibrary;
      result = scan({
        db: this.db,
        steamRoot: config.steamRoot,
        steamId64: config.steamId64,
        now: this.now,
      });
    } catch (error) {
      result = {
        status: "failed",
        error: {
          code: "INTERNAL_ERROR",
          message: `The local scan failed: ${(error as Error).message}`,
        },
        skipped: null,
        stats: {
          libraries: 0,
          manifests: 0,
          localconfigApps: 0,
          upserted: 0,
          deleted: 0,
          warnings: { negativePlaytime: 0 },
        },
        warnings: [],
      };
    }

    const finishedAt = this.now();
    const sourceStatus =
      result.status === "ok" ? "ok" : result.status === "partial" ? "partial" : "error";
    this.db
      .prepare(
        `UPDATE source_state SET
           status = ?,
           last_attempt_at = ?,
           last_success_at = CASE WHEN ? = 'ok' THEN ? ELSE last_success_at END,
           last_error = ?
         WHERE name = 'steam_local'`,
      )
      .run(sourceStatus, finishedAt, result.status, finishedAt, result.error?.message ?? null);

    for (const warning of result.warnings) {
      this.options.onWarn?.(warning, {});
    }

    return {
      status:
        result.status === "ok" ? "succeeded" : result.status === "partial" ? "partial" : "failed",
      result,
      error: result.error,
      partial: result.status !== "ok",
      fatal: result.error?.code === "ACCOUNT_MISMATCH",
    };
  }

  private async executeOwnership(row: RefreshRow, config: RunConfig): Promise<void> {
    const phase = await this.performOwnershipPhase(
      row.id,
      this.ownershipConfigured(config),
      config,
    );
    if (this.stopping) {
      return;
    }
    this.finishRun(row.id, {
      status: phase.status === "skipped" ? "partial" : phase.status,
      total: phase.total,
      done: phase.done,
      stats: null,
      error: phase.error,
    });
  }

  private async performOwnershipPhase(
    runId: number,
    configured: boolean,
    config: RunConfig,
  ): Promise<OwnershipPhaseResult> {
    if (!configured || config.steamId64 === null) {
      return {
        status: "skipped",
        total: null,
        done: 0,
        error: {
          code: "OWNERSHIP_NOT_CONFIGURED",
          message:
            "Ownership was skipped because the Steam Web API key or Steam Account is not configured.",
        },
        partial: true,
        fatal: false,
      };
    }

    const steamId64 = config.steamId64;
    const bound = readBoundSteamId64(this.db);
    if (bound !== null && bound !== steamId64) {
      const error = {
        code: "ACCOUNT_MISMATCH",
        message:
          `The database is bound to Steam Account ${bound}, but the selected Account is ` +
          `${steamId64}.`,
      };
      return { status: "failed", total: null, done: 0, error, partial: true, fatal: true };
    }

    const source =
      this.options.ownershipSource ?? createSteamOwnershipSource({ apiKey: config.steamApiKey! });
    let result: OwnershipFetchResult;
    try {
      result = await source.fetchOwnedGames(steamId64, this.stopController.signal);
    } catch {
      result = { kind: "error", message: "The Steam Web API could not be reached." };
    }

    if (result.kind === "complete" || result.kind === "partial" || result.kind === "empty") {
      try {
        if (result.kind === "empty") {
          // A successful account-scoped run binds the Account even when the
          // roster is inconclusive; it still changes no Game.
          this.db.transaction(() => bindAccount(this.db, steamId64, this.now))();
        } else {
          applyOwnershipRoster({
            db: this.db,
            steamId64,
            games: result.games,
            reconcileAbsent: result.kind === "complete",
            seenAt: this.now(),
          });
        }
      } catch (error) {
        if (error instanceof AccountMismatchError) {
          return {
            status: "failed",
            total: null,
            done: 0,
            error: { code: "ACCOUNT_MISMATCH", message: error.message },
            partial: true,
            fatal: true,
          };
        }
        return {
          status: "failed",
          total: null,
          done: 0,
          error: {
            code: "INTERNAL_ERROR",
            message: `The ownership Refresh could not be stored: ${(error as Error).message}`,
          },
          partial: true,
          fatal: true,
        };
      }

      const success = result.kind === "complete" || result.kind === "empty";
      this.updateOwnershipSource({
        status: result.kind === "complete" ? "ok" : result.kind === "empty" ? "empty" : "partial",
        lastError: result.kind === "partial" ? "Steam returned an incomplete roster." : null,
        retryAfterAt: null,
        success,
      });
      return {
        status: success ? "succeeded" : "partial",
        total:
          result.kind === "partial"
            ? Math.max(result.gameCount, result.games.length)
            : result.gameCount,
        done: result.games.length,
        error:
          result.kind === "partial"
            ? {
                code: "OWNERSHIP_PARTIAL",
                message:
                  "Steam returned fewer Games than game_count, so absent Games were not " +
                  "reconciled.",
              }
            : null,
        partial: !success,
        fatal: false,
      };
    }

    let mapping: {
      code: string;
      status: "partial";
      sourceStatus: "invalid_key" | "rate_limited" | "error";
    };
    let message: string;
    let retryAfterAt: number | null = null;
    switch (result.kind) {
      case "invalid_key":
        mapping = OWNERSHIP_RUN_ERRORS.invalid_key;
        message = result.message;
        break;
      case "rate_limited":
        mapping = OWNERSHIP_RUN_ERRORS.rate_limited;
        message = result.message;
        retryAfterAt = result.retryAfterAt;
        break;
      default: {
        const failure = result as { kind: "error"; message: string };
        mapping = OWNERSHIP_RUN_ERRORS.error;
        message = failure.message;
        break;
      }
    }
    this.updateOwnershipSource({
      status: mapping.sourceStatus,
      lastError: message,
      retryAfterAt,
      success: false,
    });
    this.options.onWarn?.(`Ownership Refresh failed for run ${runId}.`, { code: mapping.code });
    return {
      status: "partial",
      total: null,
      done: 0,
      error: { code: mapping.code, message },
      partial: true,
      fatal: false,
    };
  }

  private updateOwnershipSource(outcome: {
    status: "ok" | "partial" | "empty" | "invalid_key" | "rate_limited" | "error";
    lastError: string | null;
    retryAfterAt: number | null;
    success: boolean;
  }): void {
    const finishedAt = this.now();
    this.db
      .prepare(
        `UPDATE source_state SET
           status = ?,
           last_attempt_at = ?,
           last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
           retry_after_at = ?,
           last_error = ?
         WHERE name = 'steam_web_api'`,
      )
      .run(
        outcome.status,
        finishedAt,
        outcome.success ? 1 : 0,
        finishedAt,
        outcome.retryAfterAt,
        outcome.lastError,
      );
  }

  private async executeMetadata(row: RefreshRow): Promise<void> {
    const phase = await this.executeMetadataPhase(row.id);
    if (this.stopping) {
      return;
    }
    this.finishRun(row.id, {
      status: phase.fatal ? "failed" : phase.partial ? "partial" : "succeeded",
      total: phase.total,
      done: phase.done,
      stats: JSON.stringify(phase.stats),
      error: phase.error,
    });
  }

  private async executeAll(row: RefreshRow, config: RunConfig): Promise<void> {
    const library = this.performLibraryPhase(config);
    const libraryWarnings = { ...library.result.stats.warnings };
    const allStats = (stats: InternalMetadataStats): string =>
      JSON.stringify({ ...stats, warnings: libraryWarnings });
    if (library.fatal) {
      this.finishRun(row.id, {
        status: "failed",
        total: null,
        done: 0,
        stats: allStats(emptyInternalStats()),
        error: library.error,
      });
      return;
    }
    if (this.stopping) {
      return;
    }

    let partial = library.partial;
    let error = library.error;
    const ownership = await this.performOwnershipPhase(
      row.id,
      this.ownershipConfigured(config),
      config,
    );
    if (ownership.fatal) {
      this.finishRun(row.id, {
        status: "failed",
        total: null,
        done: 0,
        stats: allStats(emptyInternalStats()),
        error: ownership.error,
      });
      return;
    }
    if (ownership.status === "failed") {
      this.finishRun(row.id, {
        status: "failed",
        total: null,
        done: 0,
        stats: allStats(emptyInternalStats()),
        error: ownership.error,
      });
      return;
    }
    if (this.stopping) {
      return;
    }

    const metadata = await this.executeMetadataPhase(row.id);
    if (this.stopping) {
      return;
    }

    if (metadata.fatal) {
      this.finishRun(row.id, {
        status: "failed",
        total: metadata.total,
        done: metadata.done,
        stats: allStats(metadata.stats),
        error: metadata.error,
      });
      return;
    }

    // An `all` run without ownership is explicitly partial with this code.
    if (ownership.status === "skipped") {
      partial = true;
      error = ownership.error;
    } else if (ownership.partial) {
      partial = true;
      error ??= ownership.error;
    }
    if (metadata.partial) {
      partial = true;
      error ??= metadata.error;
    }
    if (library.partial) {
      partial = true;
      error ??= library.error;
    }

    // Ownership-not-configured is the documented code when it applies.
    if (ownership.status === "skipped") {
      error = ownership.error;
    }

    this.finishRun(row.id, {
      status: partial ? "partial" : "succeeded",
      total: metadata.total,
      done: metadata.done,
      stats: allStats(metadata.stats),
      error,
    });
  }

  private finishRun(
    id: number,
    outcome: {
      status: "succeeded" | "partial" | "failed";
      total: number | null;
      done: number;
      stats: string | null;
      error: ErrorDetail | null;
    },
  ): void {
    if (this.stopping) {
      return;
    }
    this.db
      .prepare(
        `UPDATE refresh_runs SET
           status = ?, finished_at = ?, total = ?, done = ?,
           stats_json = COALESCE(?, stats_json), error_code = ?, error_message = ?
         WHERE id = ?`,
      )
      .run(
        outcome.status,
        this.now(),
        outcome.total,
        outcome.done,
        outcome.stats,
        outcome.error?.code ?? null,
        outcome.error?.message ?? null,
        id,
      );
  }

  private buildSelection(row: RefreshRow): SelectionPlan {
    const plan: SelectionPlan = {
      total: 0,
      items: new Map(),
      missingAppIds: [],
      remainingByGame: new Map(),
      done: 0,
      stats: emptyInternalStats(),
      partial: false,
    };

    const sources = this.sources.entries();
    const rows = this.db
      .prepare("SELECT app_id, name FROM games ORDER BY app_id ASC")
      .all() as Array<{ app_id: number; name: string }>;
    const games = new Map(rows.map((game) => [game.app_id, game.name]));
    const retryAfter = this.readRetryAfter();

    if (row.scope === "metadata" && row.mode === "full") {
      const selection = parseAppIds(row.app_ids_json) ?? [];
      plan.total = selection.length;
      const selectedKeys = new Set(selection);
      const missing = new Set(selection);
      for (const game of rows) {
        if (selectedKeys.has(game.app_id)) {
          missing.delete(game.app_id);
        }
      }
      plan.missingAppIds = [...missing].sort((left, right) => left - right);

      for (const source of sources) {
        plan.items.set(source.name, []);
        plan.stats.sources[source.name].candidates = selection.length;
      }

      for (const appId of selection) {
        const name = games.get(appId);
        if (name === undefined) {
          // A missing App ID makes the run partial but still finishes.
          plan.partial = true;
          for (const source of sources) {
            plan.stats.sources[source.name].skipped += 1;
          }
          continue;
        }
        if (sources.length === 0) {
          plan.done += 1;
          continue;
        }
        plan.remainingByGame.set(appId, sources.length);
        for (const source of sources) {
          const deadline = retryAfter.get(source.name) ?? null;
          if (deadline !== null && deadline > this.now()) {
            plan.stats.sources[source.name].skipped += 1;
            plan.partial = true;
            this.resolveGame(plan, appId);
          } else {
            plan.items.get(source.name)!.push({ appId, name });
          }
        }
      }

      // Missing App IDs count against `done` but have no Game row.
      plan.done += plan.missingAppIds.length;
      plan.partial = plan.partial || plan.missingAppIds.length > 0;
      return plan;
    }

    // Fetch selection: pending is per `(Game, source)`.
    for (const source of sources) {
      const statusRows = this.db.prepare(SOURCE_ROW_QUERIES[source.name]).all() as Array<{
        app_id: number;
        status: string;
        fetched_at: number | null;
      }>;
      const byGame = new Map(statusRows.map((entry) => [entry.app_id, entry]));
      const items: WorkItem[] = [];
      for (const game of rows) {
        const stored = byGame.get(game.app_id);
        if (isMetadataPending(stored?.status, stored?.fetched_at ?? null)) {
          items.push({ appId: game.app_id, name: game.name });
        }
      }
      plan.items.set(source.name, items);
      plan.stats.sources[source.name].candidates = items.length;
    }

    const pendingAppIds = new Set<number>();
    for (const source of sources) {
      for (const item of plan.items.get(source.name) ?? []) {
        pendingAppIds.add(item.appId);
        plan.remainingByGame.set(item.appId, (plan.remainingByGame.get(item.appId) ?? 0) + 1);
      }
    }
    plan.total = pendingAppIds.size;
    return plan;
  }

  private readRetryAfter(): Map<MetadataSourceName, number | null> {
    const rows = this.db.prepare("SELECT name, retry_after_at FROM source_state").all() as Array<{
      name: string;
      retry_after_at: number | null;
    }>;
    const values = new Map<MetadataSourceName, number | null>();
    for (const row of rows) {
      if ((METADATA_SOURCE_NAMES as readonly string[]).includes(row.name)) {
        values.set(row.name as MetadataSourceName, row.retry_after_at);
      }
    }
    return values;
  }

  private resolveGame(plan: SelectionPlan, appId: number): void {
    const remaining = plan.remainingByGame.get(appId);
    if (remaining === undefined) {
      return;
    }
    const next = remaining - 1;
    if (next <= 0) {
      plan.remainingByGame.delete(appId);
      plan.done += 1;
    } else {
      plan.remainingByGame.set(appId, next);
    }
  }

  private async executeMetadataPhase(runId: number): Promise<MetadataPhaseResult> {
    const row = this.db.prepare("SELECT * FROM refresh_runs WHERE id = ?").get(runId) as RefreshRow;
    const plan = this.buildSelection(row);
    if (plan.missingAppIds.length > 0) {
      plan.partial = true;
    }

    // Per-Game rows can exist without a source row when an earlier pass was
    // interrupted. Reconcile a source with no pending work so a no-op Fetch
    // still reports its real last success and attempt. A Full Refresh always
    // selects its Games, so this repair belongs to Fetch only.
    if (row.mode === "fetch") {
      this.reconcileMetadataSourceState(plan);
    }

    // Source-wide backoff skips candidates without touching their data. The
    // work remains pending for a later Fetch.
    const retryAfter = this.readRetryAfter();
    for (const source of this.sources.entries()) {
      const deadline = retryAfter.get(source.name) ?? null;
      if (deadline !== null && deadline > this.now()) {
        const items = plan.items.get(source.name) ?? [];
        if (items.length > 0) {
          plan.stats.sources[source.name].skipped += items.length;
          plan.partial = true;
          for (const item of items) {
            this.resolveGame(plan, item.appId);
          }
          plan.items.set(source.name, []);
        }
      }
    }

    this.writeProgress(runId, plan);
    if (this.stopping) {
      return {
        total: plan.total,
        done: plan.done,
        stats: plan.stats,
        partial: true,
        error: null,
        fatal: false,
      };
    }

    const groups = new Map<string, MetadataSource[]>();
    for (const source of this.sources.entries()) {
      if ((plan.items.get(source.name)?.length ?? 0) === 0) {
        continue;
      }
      const key = source.hostKey ?? `source:${source.name}`;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, [source]);
      } else {
        group.push(source);
      }
    }

    const hostPause = new Map<string, HostPause>();
    /** Last upstream request time in milliseconds, per host key, for pacing. */
    const lastRequestAt = new Map<string, number>();
    let lastPersistedDone = plan.done;
    const persistIfNeeded = (): void => {
      if (plan.done - lastPersistedDone >= PROGRESS_INTERVAL) {
        lastPersistedDone = plan.done;
        this.writeProgress(runId, plan);
      }
    };

    const executeGroup = async (sources: MetadataSource[]): Promise<void> => {
      for (const source of sources) {
        if (this.stopping) {
          return;
        }
        await this.executeSourcePass(source, plan, hostPause, lastRequestAt, persistIfNeeded);
      }
    };

    await Promise.all([...groups.values()].map((group) => executeGroup(group)));

    if (this.stopping) {
      return {
        total: plan.total,
        done: plan.done,
        stats: plan.stats,
        partial: true,
        error: null,
        fatal: false,
      };
    }

    // Finish with done exactly at total; the worker persists the final value.
    plan.done = plan.total;
    this.writeProgress(runId, plan);
    return {
      total: plan.total,
      done: plan.done,
      stats: plan.stats,
      partial: plan.partial,
      error: null,
      fatal: false,
    };
  }

  private async executeSourcePass(
    source: MetadataSource,
    plan: SelectionPlan,
    hostPause: Map<string, HostPause>,
    lastRequestAt: Map<string, number>,
    persistIfNeeded: () => void,
  ): Promise<void> {
    const items = plan.items.get(source.name) ?? [];
    if (items.length === 0) {
      return;
    }
    const hostKey = source.hostKey ?? `source:${source.name}`;
    const pacingKey = source.hostKey ?? source.name;
    const now = this.now();
    const pause = hostPause.get(hostKey) ?? null;
    if (pause !== null && pause.until > now) {
      plan.stats.sources[source.name].skipped += items.length;
      plan.partial = true;
      for (const item of items) {
        this.resolveGame(plan, item.appId);
      }
      plan.items.set(source.name, []);
      // A skipped pass inherits the pause reason from §6.8: a block stays
      // `blocked`, a 429 stays `rate_limited`.
      this.updateMetadataSourceState(source.name, {
        status: pause.reason,
        lastAttemptAt: null,
        lastSuccessAt: null,
        retryAfterAt: pause.until,
        lastError: "The shared store host is paused until its retry time.",
      });
      persistIfNeeded();
      return;
    }

    let consecutiveFailures = 0;
    let successes = 0;
    let failures = 0;
    let nonRetryableFailures = 0;
    // A failure counted against the pass; it outranks the message from the most
    // recent failed attempt when the interruption write picks a last error.
    let lastCountedFailureMessage: string | null = null;
    let lastAttemptFailureMessage: string | null = null;
    let lastSuccessAt: number | null = null;
    let attemptedAt: number | null = null;
    let paused = false;

    try {
      for (let index = 0; index < items.length; index += 1) {
        if (this.stopping) {
          return;
        }
        const item = items[index]!;
        let attempt = 0;

        while (true) {
          attempt += 1;
          if (this.stopping) {
            return;
          }
          await this.pace(pacingKey, lastRequestAt);
          if (this.stopping) {
            return;
          }
          lastRequestAt.set(pacingKey, this.nowMs());
          // §6.4: a source row is committed as work completes. Record the first
          // attempt before the request so an in-flight or interrupted pass is
          // visible in `/errors`, not only in the run record.
          const startedAt = this.now();
          if (attemptedAt === null) {
            this.markMetadataSourceAttempted(source.name, startedAt);
          }
          attemptedAt = startedAt;
          let outcome: MetadataSourceOutcome;
          try {
            outcome = await source.fetch({
              db: this.db,
              game: item,
              now: this.now(),
              signal: this.stopController.signal,
            });
          } catch (error) {
            outcome = {
              kind: "error",
              message: `The ${source.name} request failed: ${(error as Error).message}`,
            };
          }
          if (this.stopping) {
            return;
          }

          if (
            outcome.kind === "ok" ||
            outcome.kind === "missing" ||
            outcome.kind === "unavailable"
          ) {
            plan.stats.sources[source.name].done += 1;
            successes += 1;
            lastSuccessAt = this.now();
            lastAttemptFailureMessage = null;
            consecutiveFailures = 0;
            this.resolveGame(plan, item.appId);
            persistIfNeeded();
            break;
          }

          // A non-success outcome is the most recent failed attempt. The
          // pass-end or interruption write reports it when no source-wide
          // terminal message exists.
          lastAttemptFailureMessage = outcome.message;

          if (outcome.kind === "rate_limited") {
            // No Retry-After means Steam gives no deadline: retry this request
            // with full-jitter exponential backoff (§6.8). Pacing still runs
            // before each attempt, and the source issues no other request while
            // the backoff waits. Once the attempts are exhausted, record the
            // source-wide pause for later Fetch runs.
            if (outcome.retryAfterAt === null && attempt < MAX_ATTEMPTS) {
              await this.sleep(this.backoffMilliseconds(attempt));
              continue;
            }
            const at = this.now();
            const until = outcome.retryAfterAt ?? at + this.backoffSeconds(attempt);
            const previous = hostPause.get(hostKey);
            hostPause.set(hostKey, {
              until: Math.max(previous?.until ?? 0, until),
              reason: "rate_limited",
            });
            this.updateMetadataSourceState(source.name, {
              status: "rate_limited",
              lastAttemptAt: at,
              lastSuccessAt: null,
              retryAfterAt: until,
              lastError: outcome.message,
            });
            paused = true;
            this.skipFrom(plan, source.name, items, index);
            persistIfNeeded();
            return;
          }

          if (outcome.kind === "blocked") {
            const at = this.now();
            const until = at + BLOCK_SECONDS;
            const previous = hostPause.get(hostKey);
            hostPause.set(hostKey, {
              until: Math.max(previous?.until ?? 0, until),
              reason: "blocked",
            });
            this.updateMetadataSourceState(source.name, {
              status: "blocked",
              lastAttemptAt: at,
              lastSuccessAt: null,
              retryAfterAt: until,
              lastError: outcome.message,
            });
            paused = true;
            this.skipFrom(plan, source.name, items, index);
            persistIfNeeded();
            return;
          }

          // A non-retryable `error` (for example a storefront `400`) records the
          // failure immediately and moves on without another request.
          if (outcome.retryable === false) {
            plan.stats.sources[source.name].failed += 1;
            failures += 1;
            nonRetryableFailures += 1;
            lastCountedFailureMessage = outcome.message;
            // A failed Game always makes the run partial, even when it is the
            // only Game and no retry follows (§6.4).
            plan.partial = true;
            this.resolveGame(plan, item.appId);
            persistIfNeeded();
            break;
          }

          // `error`: retry with full jitter, then record the failure and keep
          // going. Five consecutive failed attempts open the source circuit.
          consecutiveFailures += 1;
          if (consecutiveFailures >= CIRCUIT_FAILURES) {
            const at = this.now();
            const until = at + BLOCK_SECONDS;
            this.updateMetadataSourceState(source.name, {
              status: "error",
              lastAttemptAt: at,
              lastSuccessAt: null,
              retryAfterAt: until,
              lastError: outcome.message,
            });
            plan.stats.sources[source.name].failed += 1;
            failures += 1;
            lastCountedFailureMessage = outcome.message;
            plan.partial = true;
            this.resolveGame(plan, item.appId);
            paused = true;
            this.skipFrom(plan, source.name, items, index + 1);
            persistIfNeeded();
            return;
          }

          if (attempt >= MAX_ATTEMPTS) {
            plan.stats.sources[source.name].failed += 1;
            failures += 1;
            lastCountedFailureMessage = outcome.message;
            // A failed Game always makes the run partial, even when no successful
            // Game hides the failure (§6.4 regression).
            plan.partial = true;
            this.resolveGame(plan, item.appId);
            persistIfNeeded();
            break;
          }

          await this.sleep(this.backoffMilliseconds(attempt));
        }
      }

      if (!paused) {
        const finishedAt = this.now();
        // A non-retryable (source-wide) failure is recorded as `error`; if other
        // Games already succeeded the source is `partial`. Retry-exhausted
        // per-Game failures leave the source row `ok` when some Games succeeded,
        // because a per-Game failure does not by itself change source state.
        const status: "ok" | "partial" | "error" =
          nonRetryableFailures > 0
            ? successes > 0
              ? "partial"
              : "error"
            : failures > 0 && successes === 0
              ? "error"
              : "ok";
        this.updateMetadataSourceState(source.name, {
          status,
          lastAttemptAt: finishedAt,
          lastSuccessAt: successes > 0 ? finishedAt : null,
          retryAfterAt: null,
          lastError:
            failures > 0 ? (lastCountedFailureMessage ?? "Some Games could not be fetched.") : null,
        });
      }
      persistIfNeeded();
    } finally {
      // An interrupted pass still carries evidence: the latest attempt time, any
      // success before the stop, and the last safe failure. Without this the
      // source row would keep its last completed pass instead.
      if (!paused && this.stopping && attemptedAt !== null) {
        this.updateMetadataSourceState(source.name, {
          // A shutdown is not a failed attempt, so an interrupted pass is always
          // partial: it started (and maybe read data) but did not finish.
          status: "partial",
          // A success completes after the request started, so never let the
          // attempt timestamp land before the success timestamp.
          lastAttemptAt: Math.max(attemptedAt, lastSuccessAt ?? 0),
          lastSuccessAt,
          retryAfterAt: null,
          lastError:
            lastCountedFailureMessage ??
            lastAttemptFailureMessage ??
            (successes > 0 ? null : "The Refresh run stopped before this source finished."),
        });
      }
    }
  }

  private skipFrom(
    plan: SelectionPlan,
    name: MetadataSourceName,
    items: WorkItem[],
    from: number,
  ): void {
    for (let index = from; index < items.length; index += 1) {
      const item = items[index]!;
      plan.stats.sources[name].skipped += 1;
      plan.partial = true;
      this.resolveGame(plan, item.appId);
    }
  }

  /**
   * Record that a Metadata source has started its first request. Replacing
   * `unknown` with `partial` keeps an in-flight pass from looking never
   * attempted; the pass-end or interruption write carries the final result
   * (§6.4).
   */
  private markMetadataSourceAttempted(name: MetadataSourceName, at: number): void {
    this.db
      .prepare(
        `UPDATE source_state
            SET last_attempt_at = ?,
                status = CASE WHEN status = 'unknown' THEN 'partial' ELSE status END
          WHERE name = ?`,
      )
      .run(at, name);
  }

  /**
   * Reconcile a Metadata source row from its per-Game rows when the source has
   * no pending work. Per-Game rows are committed before the source row, so an
   * interrupted pass can leave real data with no final source-level record, and
   * a later Fetch with nothing to do would never write it. A hard kill leaves
   * the row `partial`, so any non-`ok` row is repaired, not only `unknown`.
   *
   * A `missing` row with no `*_fetched_at` is pending, not attempted (§6.2), and
   * a source with any pending or failed per-Game row is skipped here because
   * its next pass writes the row. A reconciled row therefore always has a
   * successful `*_fetched_at` and becomes `ok`.
   */
  private reconcileMetadataSourceState(plan: SelectionPlan): void {
    for (const source of this.sources.entries()) {
      if ((plan.items.get(source.name)?.length ?? 0) > 0) {
        continue;
      }
      const row = this.db
        .prepare("SELECT status FROM source_state WHERE name = ?")
        .get(source.name) as { status: SourceStatus } | undefined;
      if (row === undefined || row.status === "ok") {
        continue;
      }
      const aggregate = this.db
        .prepare(
          `SELECT MAX(fetched_at) AS last_success_at,
                  MAX(updated_at) AS last_attempt_at,
                  COUNT(CASE WHEN fetched_at IS NOT NULL OR status <> 'missing' THEN 1 END)
                    AS attempted
             FROM (${SOURCE_ROW_QUERIES[source.name]})`,
        )
        .get() as {
        last_success_at: number | null;
        last_attempt_at: number | null;
        attempted: number;
      };
      if (aggregate.attempted === 0) {
        continue;
      }
      this.db
        .prepare(
          `UPDATE source_state
              SET status = 'ok',
                  last_success_at = ?,
                  last_attempt_at = ?,
                  retry_after_at = NULL,
                  last_error = NULL
            WHERE name = ?`,
        )
        .run(aggregate.last_success_at, aggregate.last_attempt_at, source.name);
    }
  }

  private updateMetadataSourceState(
    name: MetadataSourceName,
    value: {
      status: "ok" | "partial" | "rate_limited" | "blocked" | "error";
      lastAttemptAt: number | null;
      lastSuccessAt: number | null;
      retryAfterAt: number | null;
      lastError: string | null;
    },
  ): void {
    const existing = this.db
      .prepare("SELECT last_attempt_at, last_success_at FROM source_state WHERE name = ?")
      .get(name) as { last_attempt_at: number | null; last_success_at: number | null } | undefined;
    this.db
      .prepare(
        `UPDATE source_state SET
           status = ?,
           last_attempt_at = ?,
           last_success_at = ?,
           retry_after_at = ?,
           last_error = ?
         WHERE name = ?`,
      )
      .run(
        value.status,
        value.lastAttemptAt ?? existing?.last_attempt_at ?? null,
        value.lastSuccessAt ?? existing?.last_success_at ?? null,
        value.retryAfterAt,
        value.lastError,
        name,
      );
  }

  private writeProgress(runId: number, plan: SelectionPlan): void {
    if (this.stopping) {
      return;
    }
    plan.stats.lastProgressAt = this.now();
    const stats = JSON.stringify(plan.stats);
    this.db
      .prepare(`UPDATE refresh_runs SET total = ?, done = ?, stats_json = ? WHERE id = ?`)
      .run(plan.total, plan.done, stats, runId);
  }

  private backoffSeconds(attempt: number): number {
    const cap = Math.min(60, 2 * 2 ** Math.max(0, attempt - 1));
    return Math.max(1, Math.round(cap * this.jitter()));
  }

  private backoffMilliseconds(attempt: number): number {
    const cap = Math.min(60, 2 * 2 ** Math.max(0, attempt - 1));
    return Math.round(cap * 1_000 * this.jitter());
  }
}
