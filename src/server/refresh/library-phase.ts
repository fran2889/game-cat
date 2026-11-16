import type BetterSqlite3 from "better-sqlite3";
import { sql } from "kysely";
import { queryFor, runSync } from "../db/query.ts";
import { scanLocalLibrary, type LibraryScanResult } from "../library/scan.ts";
import type { LibraryPhaseResult } from "./types.ts";

/**
 * The Library phase (spec §4.3, §5). Scans the Steam root and writes the
 * `steam_local` source row; the worker persists the run outcome.
 */

export interface LibraryPhaseOptions {
  db: BetterSqlite3.Database;
  steamRoot: string | null;
  steamId64: string | null;
  now: () => number;
  scan?: typeof scanLocalLibrary;
  onWarn?: (message: string, details: Record<string, unknown>) => void;
}

export function performLibraryPhase(options: LibraryPhaseOptions): LibraryPhaseResult {
  const { db, now } = options;
  let result: LibraryScanResult;
  try {
    const scan = options.scan ?? scanLocalLibrary;
    result = scan({
      db,
      steamRoot: options.steamRoot,
      steamId64: options.steamId64,
      now,
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

  const finishedAt = now();
  const sourceStatus =
    result.status === "ok" ? "ok" : result.status === "partial" ? "partial" : "error";
  runSync(
    db,
    queryFor(db)
      .updateTable("source_state")
      .set({
        status: sourceStatus,
        last_attempt_at: finishedAt,
        last_success_at: sql<
          number | null
        >`CASE WHEN ${result.status} = 'ok' THEN ${finishedAt} ELSE last_success_at END`,
        last_error: result.error?.message ?? null,
      })
      .where("name", "=", "steam_local")
      .compile(),
  );

  for (const warning of result.warnings) {
    options.onWarn?.(warning, {});
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
