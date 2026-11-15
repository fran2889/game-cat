import type BetterSqlite3 from "better-sqlite3";
import type { ErrorDetail, RefreshMode, RefreshRun, RefreshScope } from "../../shared/types.ts";
import { HttpError } from "../errors.ts";
import { scanLocalLibrary, type LibraryScanResult } from "../library/scan.ts";

/**
 * The smallest Refresh engine needed for the first local scan.
 *
 * It deliberately handles only `scope: "library"` synchronously. #27 owns the
 * general worker, scope/mode validation, deduplication, and progress; the run
 * record shape and the service seam are already the documented ones so that
 * work can replace the execution without changing the HTTP contract.
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
  now?: () => number;
  scan?: typeof scanLocalLibrary;
  onWarn?: (message: string, details: Record<string, unknown>) => void;
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

export class RefreshService {
  private readonly db: BetterSqlite3.Database;
  private readonly now: () => number;

  constructor(private readonly options: RefreshServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? unixSeconds;
  }

  /** Validate and execute the documented `library` run. #27 generalizes this. */
  start(body: unknown): RefreshRun {
    const parsed = this.parseBody(body);
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
         VALUES ('library', NULL, 'running', ?, ?, 0)`,
      )
      .run(this.options.steamId64, startedAt);
    const id = Number(info.lastInsertRowid);

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

    return readRefreshRun(this.db, id)!;
  }

  get(id: number): RefreshRun | null {
    return readRefreshRun(this.db, id);
  }

  private parseBody(body: unknown): { scope: "library" } {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw validationError({ body: "must be an object" });
    }
    const record = body as Record<string, unknown>;
    const fieldErrors: Record<string, string> = {};

    if (record.scope === undefined) {
      fieldErrors.scope = "is required";
    } else if (typeof record.scope !== "string") {
      fieldErrors.scope = "must be a string";
    } else if (record.scope !== "library") {
      fieldErrors.scope = "only the library scope is available in this build";
    }
    if (record.mode !== undefined) {
      fieldErrors.mode = "library runs do not accept a mode";
    }
    if (record.appIds !== undefined) {
      fieldErrors.appIds = "library runs do not accept appIds";
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw validationError(fieldErrors);
    }
    return { scope: "library" };
  }
}
