import type BetterSqlite3 from "better-sqlite3";
import type { ErrorDetail, RefreshMode, RefreshRun, RefreshScope } from "../../shared/types.ts";
import { readBoundSteamId64 } from "../db/database.ts";
import { HttpError } from "../errors.ts";
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

/**
 * The smallest Refresh engine needed for local scans and ownership.
 *
 * It handles `scope: "library"` and `scope: "ownership"`; #27 owns the general
 * worker, `metadata`/`all`, deduplication, and progress. The run record shape
 * and the service seam are already the documented ones so that work can replace
 * the execution without changing the HTTP contract.
 */

interface RefreshRow {
  id: number;
  scope: RefreshScope;
  mode: RefreshMode | null;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
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

export interface RefreshServiceOptions {
  db: BetterSqlite3.Database;
  steamRoot: string | null;
  steamId64: string | null;
  /** Server-side only. Never logged, stored, or returned. */
  steamApiKey?: string | null;
  now?: () => number;
  scan?: typeof scanLocalLibrary;
  /** Injectable ownership adapter. Tests use a fake; production builds one from the key. */
  ownershipSource?: SteamOwnershipSource;
  onWarn?: (message: string, details: Record<string, unknown>) => void;
}

interface ParsedRefreshBody {
  scope: "library" | "ownership";
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toIso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
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

function parseStats(raw: string | null): RefreshRun["stats"] {
  if (raw === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const sources = (value as { sources?: unknown }).sources;
    if (typeof sources !== "object" || sources === null) {
      return null;
    }
    return value as RefreshRun["stats"];
  } catch {
    return null;
  }
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
    // §4.2: stats is null for library and ownership runs.
    stats: row.scope === "library" || row.scope === "ownership" ? null : parseStats(row.stats_json),
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

function validationError(fieldErrors: Record<string, string>): HttpError {
  return new HttpError(422, "VALIDATION_ERROR", "Request body is invalid", {
    details: { fieldErrors },
  });
}

const OWNERSHIP_RUN_ERRORS: Record<
  Exclude<OwnershipFetchResult["kind"], "complete" | "empty">,
  {
    code: string;
    status: "partial";
    sourceStatus: "partial" | "invalid_key" | "rate_limited" | "error";
  }
> = {
  partial: { code: "OWNERSHIP_PARTIAL", status: "partial", sourceStatus: "partial" },
  invalid_key: { code: "INVALID_KEY", status: "partial", sourceStatus: "invalid_key" },
  rate_limited: { code: "RATE_LIMITED", status: "partial", sourceStatus: "rate_limited" },
  error: { code: "OWNERSHIP_REQUEST_FAILED", status: "partial", sourceStatus: "error" },
};

export class RefreshService {
  private readonly db: BetterSqlite3.Database;
  private readonly now: () => number;

  constructor(private readonly options: RefreshServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? unixSeconds;
  }

  /** Validate and execute a documented `library` or `ownership` run. */
  async start(body: unknown): Promise<RefreshRun> {
    const parsed = this.parseBody(body);
    if (parsed.scope === "ownership") {
      this.assertOwnershipConfigured();
    }

    const running = this.db
      .prepare(
        "SELECT * FROM refresh_runs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1",
      )
      .get() as RefreshRow | undefined;
    if (running !== undefined) {
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
    const info = this.db
      .prepare(
        `INSERT INTO refresh_runs (scope, mode, status, steam_id64, started_at, done)
         VALUES (?, NULL, 'running', ?, ?, 0)`,
      )
      .run(parsed.scope, this.options.steamId64, startedAt);
    const id = Number(info.lastInsertRowid);

    if (parsed.scope === "library") {
      this.executeLibrary(id);
    } else {
      await this.executeOwnership(id);
    }

    return readRefreshRun(this.db, id)!;
  }

  get(id: number): RefreshRun | null {
    return readRefreshRun(this.db, id);
  }

  private assertOwnershipConfigured(): void {
    const missing: string[] = [];
    if (this.options.steamApiKey === null || this.options.steamApiKey === undefined) {
      missing.push("webApiKey");
    }
    if (this.options.steamId64 === null) {
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

  private executeLibrary(id: number): void {
    let result: LibraryScanResult;
    try {
      const scan = this.options.scan ?? scanLocalLibrary;
      result = scan({
        db: this.db,
        steamRoot: this.options.steamRoot,
        steamId64: this.options.steamId64,
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
    const status =
      result.status === "ok" ? "succeeded" : result.status === "partial" ? "partial" : "failed";
    const statsJson = JSON.stringify({
      ...result.stats,
      ...(result.skipped === null ? {} : { skipped: result.skipped }),
    });

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE refresh_runs SET
             status = ?, finished_at = ?, total = ?, done = ?,
             stats_json = ?, error_code = ?, error_message = ?
           WHERE id = ?`,
        )
        .run(
          status,
          finishedAt,
          result.stats.upserted,
          result.stats.upserted,
          statsJson,
          result.error?.code ?? null,
          result.error?.message ?? null,
          id,
        );
      this.db
        .prepare(
          `UPDATE source_state SET
             status = ?,
             last_attempt_at = ?,
             last_success_at = CASE WHEN ? = 'ok' THEN ? ELSE last_success_at END,
             last_error = ?
           WHERE name = 'steam_local'`,
        )
        .run(
          result.status === "ok" ? "ok" : result.status === "partial" ? "partial" : "error",
          finishedAt,
          result.status,
          finishedAt,
          result.error?.message ?? null,
        );
    })();

    for (const warning of result.warnings) {
      this.options.onWarn?.(warning, { refreshRunId: String(id) });
    }
  }

  private async executeOwnership(id: number): Promise<void> {
    const steamId64 = this.options.steamId64!;
    const bound = readBoundSteamId64(this.db);
    if (bound !== null && bound !== steamId64) {
      this.finishOwnership(id, {
        runStatus: "failed",
        total: null,
        done: 0,
        error: {
          code: "ACCOUNT_MISMATCH",
          message:
            `The database is bound to Steam Account ${bound}, but the selected Account is ` +
            `${steamId64}.`,
        },
        source: null,
      });
      return;
    }

    const source =
      this.options.ownershipSource ??
      createSteamOwnershipSource({ apiKey: this.options.steamApiKey! });
    let result: OwnershipFetchResult;
    try {
      result = await source.fetchOwnedGames(steamId64);
    } catch {
      this.finishOwnership(id, {
        runStatus: "partial",
        total: null,
        done: 0,
        error: {
          code: "OWNERSHIP_REQUEST_FAILED",
          message: "The Steam Web API could not be reached.",
        },
        source: {
          status: "error",
          lastError: "The Steam Web API could not be reached.",
          retryAfterAt: null,
          success: false,
        },
      });
      return;
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
          this.finishOwnership(id, {
            runStatus: "failed",
            total: null,
            done: 0,
            error: { code: "ACCOUNT_MISMATCH", message: error.message },
            source: null,
          });
          return;
        }
        this.finishOwnership(id, {
          runStatus: "failed",
          total: null,
          done: 0,
          error: {
            code: "INTERNAL_ERROR",
            message: `The ownership Refresh could not be stored: ${(error as Error).message}`,
          },
          source: null,
        });
        return;
      }

      const success = result.kind === "complete" || result.kind === "empty";
      this.finishOwnership(id, {
        runStatus: success ? "succeeded" : "partial",
        total: result.gameCount,
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
        source: {
          status: result.kind === "complete" ? "ok" : result.kind === "empty" ? "empty" : "partial",
          lastError: result.kind === "partial" ? "Steam returned an incomplete roster." : null,
          retryAfterAt: null,
          success: result.kind !== "partial",
        },
      });
      return;
    }

    let mapping: {
      code: string;
      status: "partial";
      sourceStatus: "partial" | "invalid_key" | "rate_limited" | "error";
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
    this.finishOwnership(id, {
      runStatus: mapping.status,
      total: null,
      done: 0,
      error: { code: mapping.code, message },
      source: {
        status: mapping.sourceStatus,
        lastError: message,
        retryAfterAt,
        success: false,
      },
    });
  }

  private finishOwnership(
    id: number,
    outcome: {
      runStatus: "succeeded" | "partial" | "failed";
      total: number | null;
      done: number;
      error: ErrorDetail | null;
      source: {
        status: "ok" | "partial" | "empty" | "invalid_key" | "rate_limited" | "error";
        lastError: string | null;
        retryAfterAt: number | null;
        success: boolean;
      } | null;
    },
  ): void {
    const finishedAt = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE refresh_runs SET
             status = ?, finished_at = ?, total = ?, done = ?,
             error_code = ?, error_message = ?
           WHERE id = ?`,
        )
        .run(
          outcome.runStatus,
          finishedAt,
          outcome.total,
          outcome.done,
          outcome.error?.code ?? null,
          outcome.error?.message ?? null,
          id,
        );
      if (outcome.source !== null) {
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
            outcome.source.status,
            finishedAt,
            outcome.source.success ? 1 : 0,
            finishedAt,
            outcome.source.retryAfterAt,
            outcome.source.lastError,
          );
      }
    })();
  }

  private parseBody(body: unknown): ParsedRefreshBody {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw validationError({ body: "must be an object" });
    }
    const record = body as Record<string, unknown>;
    const fieldErrors: Record<string, string> = {};

    if (record.scope === undefined) {
      fieldErrors.scope = "is required";
    } else if (typeof record.scope !== "string") {
      fieldErrors.scope = "must be a string";
    } else if (record.scope !== "library" && record.scope !== "ownership") {
      fieldErrors.scope = "only the library and ownership scopes are available in this build";
    }
    const scope = record.scope === "ownership" ? "ownership" : "library";
    if (record.mode !== undefined) {
      fieldErrors.mode = `${scope} runs do not accept a mode`;
    }
    if (record.appIds !== undefined) {
      fieldErrors.appIds = `${scope} runs do not accept appIds`;
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw validationError(fieldErrors);
    }
    return { scope };
  }
}
