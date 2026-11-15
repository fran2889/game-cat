import type BetterSqlite3 from "better-sqlite3";
import { normalizeNameKey } from "../../shared/names.ts";
import { bindAccount, LOCAL_EVIDENCE_MASK } from "../library/scan.ts";
import type { OwnedGame } from "../steam/ownership.ts";

/**
 * Reconcile a `GetOwnedGames` roster into `games` (spec §6.10).
 *
 * The caller has already classified the response. A complete response is the
 * only one that reconciles absent rows; a short response upserts what it
 * returned and leaves everything else alone.
 */

export interface ApplyOwnershipOptions {
  db: BetterSqlite3.Database;
  steamId64: string;
  games: readonly OwnedGame[];
  /** True only for a conclusive response (`game_count > 0` and complete). */
  reconcileAbsent: boolean;
  seenAt: number;
}

export interface ApplyOwnershipResult {
  upserted: number;
  deleted: number;
  demoted: number;
}

interface GameRow {
  app_id: number;
  name: string;
  name_key: string;
  name_source: string;
  ownership_status: "owned" | "local_only" | "unknown";
  local_playtime_minutes: number | null;
  local_playtime_2weeks_minutes: number | null;
  api_playtime_minutes: number | null;
  api_playtime_2weeks_minutes: number | null;
  source_mask: number;
}

/** Ownership may replace these previous name sources (§2.7). */
const OWNERSHIP_NAME_SOURCES = new Set(["placeholder", "local", "steamspy", "steam_web_api"]);

export function applyOwnershipRoster(options: ApplyOwnershipOptions): ApplyOwnershipResult {
  const { db, steamId64, games, reconcileAbsent, seenAt } = options;

  return db.transaction(() => {
    // The Account binding is part of the same transaction: a mismatch throws
    // before any roster write is committed.
    bindAccount(db, steamId64, () => seenAt);

    const existingRows = db.prepare("SELECT * FROM games").all() as GameRow[];
    const existing = new Map(existingRows.map((row) => [row.app_id, row]));
    const roster = new Map<number, OwnedGame>();
    for (const game of games) {
      if (!roster.has(game.appId)) {
        roster.set(game.appId, game);
      }
    }

    const insert = db.prepare(`
      INSERT INTO games (
        app_id, name, name_key, name_source, ownership_status,
        local_playtime_minutes, local_playtime_2weeks_minutes,
        api_playtime_minutes, api_playtime_2weeks_minutes,
        playtime_minutes, playtime_2weeks_minutes,
        source_mask, first_seen_at, last_seen_at
      ) VALUES (
        @appId, @name, @nameKey, @nameSource, 'owned',
        NULL, NULL,
        @apiPlaytime, @apiRecent,
        @playtime, @recent,
        1, @seenAt, @seenAt
      )
    `);

    const update = db.prepare(`
      UPDATE games SET
        name = @name,
        name_key = @nameKey,
        name_source = @nameSource,
        ownership_status = 'owned',
        api_playtime_minutes = @apiPlaytime,
        api_playtime_2weeks_minutes = @apiRecent,
        playtime_minutes = @playtime,
        playtime_2weeks_minutes = @recent,
        source_mask = @sourceMask,
        last_seen_at = @seenAt
      WHERE app_id = @appId
    `);

    const demote = db.prepare(`
      UPDATE games SET ownership_status = 'local_only', source_mask = @sourceMask
      WHERE app_id = @appId
    `);
    const clearOwnedBit = db.prepare(
      "UPDATE games SET source_mask = @sourceMask WHERE app_id = @appId",
    );
    const remove = db.prepare("DELETE FROM games WHERE app_id = ?");

    let upserted = 0;
    for (const game of roster.values()) {
      const row = existing.get(game.appId);
      const name = nameFor(row, game.name, game.appId);
      const localPlaytime = row?.local_playtime_minutes ?? null;
      const localRecent = row?.local_playtime_2weeks_minutes ?? null;
      const parameters = {
        appId: game.appId,
        ...name,
        apiPlaytime: game.playtimeForeverMinutes,
        apiRecent: game.playtime2WeeksMinutes,
        playtime: localPlaytime ?? game.playtimeForeverMinutes,
        recent: localRecent ?? game.playtime2WeeksMinutes,
        sourceMask: (row?.source_mask ?? 0) | 1,
        seenAt,
      };
      if (row === undefined) {
        insert.run(parameters);
      } else {
        update.run(parameters);
      }
      upserted += 1;
    }

    let deleted = 0;
    let demoted = 0;
    if (reconcileAbsent) {
      for (const row of existingRows) {
        if (roster.has(row.app_id)) {
          continue;
        }
        const sourceMask = row.source_mask & ~1;
        if ((sourceMask & LOCAL_EVIDENCE_MASK) !== 0) {
          demote.run({ appId: row.app_id, sourceMask });
          demoted += 1;
        } else if (row.ownership_status === "owned") {
          // Metadata, Tag, and Collection membership rows cascade with the Game.
          remove.run(row.app_id);
          deleted += 1;
        } else {
          clearOwnedBit.run({ appId: row.app_id, sourceMask });
        }
      }
    }

    return { upserted, deleted, demoted };
  })();
}

function nameFor(
  row: GameRow | undefined,
  incoming: string | null,
  appId: number,
): { name: string; nameKey: string; nameSource: string } {
  const trimmed = incoming?.trim() ?? "";
  if (row === undefined) {
    if (trimmed === "") {
      return {
        name: `Game ${appId}`,
        nameKey: normalizeNameKey(`Game ${appId}`),
        nameSource: "placeholder",
      };
    }
    return { name: trimmed, nameKey: normalizeNameKey(trimmed), nameSource: "steam_web_api" };
  }

  if (trimmed === "" || !OWNERSHIP_NAME_SOURCES.has(row.name_source)) {
    return { name: row.name, nameKey: row.name_key, nameSource: row.name_source };
  }

  return { name: trimmed, nameKey: normalizeNameKey(trimmed), nameSource: "steam_web_api" };
}
