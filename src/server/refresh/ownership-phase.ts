import type BetterSqlite3 from "better-sqlite3";
import { sql } from "kysely";
import { readBoundSteamId64 } from "../db/database.ts";
import { queryFor, runSync } from "../db/query.ts";
import { AccountMismatchError, bindAccount } from "../library/scan.ts";
import {
  createSteamOwnershipSource,
  type OwnershipFetchResult,
  type SteamOwnershipSource,
} from "../steam/ownership.ts";
import { applyOwnershipRoster } from "./ownership.ts";
import type { OwnershipPhaseResult, RunConfig } from "./types.ts";

/**
 * The Ownership phase (spec §6.10, §8.6). Fetches one roster, reconciles it
 * into `games`, and writes the `steam_web_api` source row.
 */

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

export interface OwnershipPhaseOptions {
  db: BetterSqlite3.Database;
  runId: number;
  config: RunConfig;
  now: () => number;
  signal: AbortSignal;
  /** Injectable ownership adapter. Tests use a fake; production builds one from the key. */
  ownershipSource?: SteamOwnershipSource;
  onWarn?: (message: string, details: Record<string, unknown>) => void;
}

export async function performOwnershipPhase(
  options: OwnershipPhaseOptions,
): Promise<OwnershipPhaseResult> {
  const { db, config, now } = options;
  const configured = config.steamApiKey !== null && config.steamId64 !== null;
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
  const bound = readBoundSteamId64(db);
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
    options.ownershipSource ?? createSteamOwnershipSource({ apiKey: config.steamApiKey! });
  let result: OwnershipFetchResult;
  try {
    result = await source.fetchOwnedGames(steamId64, options.signal);
  } catch {
    result = { kind: "error", message: "The Steam Web API could not be reached." };
  }

  if (result.kind === "complete" || result.kind === "partial" || result.kind === "empty") {
    try {
      if (result.kind === "empty") {
        // A successful account-scoped run binds the Account even when the
        // roster is inconclusive; it still changes no Game.
        db.transaction(() => bindAccount(db, steamId64, now))();
      } else {
        applyOwnershipRoster({
          db,
          steamId64,
          games: result.games,
          reconcileAbsent: result.kind === "complete",
          seenAt: now(),
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
    updateOwnershipSource(options, {
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
  updateOwnershipSource(options, {
    status: mapping.sourceStatus,
    lastError: message,
    retryAfterAt,
    success: false,
  });
  options.onWarn?.(`Ownership Refresh failed for run ${options.runId}.`, { code: mapping.code });
  return {
    status: "partial",
    total: null,
    done: 0,
    error: { code: mapping.code, message },
    partial: true,
    fatal: false,
  };
}

function updateOwnershipSource(
  options: OwnershipPhaseOptions,
  outcome: {
    status: "ok" | "partial" | "empty" | "invalid_key" | "rate_limited" | "error";
    lastError: string | null;
    retryAfterAt: number | null;
    success: boolean;
  },
): void {
  const finishedAt = options.now();
  runSync(
    options.db,
    queryFor(options.db)
      .updateTable("source_state")
      .set({
        status: outcome.status,
        last_attempt_at: finishedAt,
        last_success_at: sql<
          number | null
        >`CASE WHEN ${outcome.success ? 1 : 0} = 1 THEN ${finishedAt} ELSE last_success_at END`,
        retry_after_at: outcome.retryAfterAt,
        last_error: outcome.lastError,
      })
      .where("name", "=", "steam_web_api")
      .compile(),
  );
}
