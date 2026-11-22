import type BetterSqlite3 from "better-sqlite3";
import { normalizeNameKey } from "../../shared/names.ts";
import { allSync, queryFor, runSync } from "../db/query.ts";
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

    const existingRows = allSync<GameRow>(
      db,
      queryFor(db).selectFrom("games").selectAll().compile(),
    );
    const existing = new Map(existingRows.map((row) => [row.app_id, row]));
    const roster = new Map<number, OwnedGame>();
    for (const game of games) {
      if (!roster.has(game.appId)) {
        roster.set(game.appId, game);
      }
    }

    let upserted = 0;
    for (const game of roster.values()) {
      const row = existing.get(game.appId);
      const name = nameFor(row, game.name, game.appId);
      const localPlaytime = row?.local_playtime_minutes ?? null;
      const localRecent = row?.local_playtime_2weeks_minutes ?? null;
      const playtime = localPlaytime ?? game.playtimeForeverMinutes;
      const recent = localRecent ?? game.playtime2WeeksMinutes;
      const sourceMask = (row?.source_mask ?? 0) | 1;
      if (row === undefined) {
        runSync(
          db,
          queryFor(db)
            .insertInto("games")
            .values({
              app_id: game.appId,
              name: name.name,
              name_key: name.nameKey,
              name_source: name.nameSource,
              ownership_status: "owned",
              local_playtime_minutes: null,
              local_playtime_2weeks_minutes: null,
              api_playtime_minutes: game.playtimeForeverMinutes,
              api_playtime_2weeks_minutes: game.playtime2WeeksMinutes,
              playtime_minutes: playtime,
              playtime_2weeks_minutes: recent,
              source_mask: 1,
              first_seen_at: seenAt,
              last_seen_at: seenAt,
            })
            .compile(),
        );
      } else {
        runSync(
          db,
          queryFor(db)
            .updateTable("games")
            .set({
              name: name.name,
              name_key: name.nameKey,
              name_source: name.nameSource,
              ownership_status: "owned",
              api_playtime_minutes: game.playtimeForeverMinutes,
              api_playtime_2weeks_minutes: game.playtime2WeeksMinutes,
              playtime_minutes: playtime,
              playtime_2weeks_minutes: recent,
              source_mask: sourceMask,
              last_seen_at: seenAt,
            })
            .where("app_id", "=", game.appId)
            .compile(),
        );
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
          runSync(
            db,
            queryFor(db)
              .updateTable("games")
              .set({ ownership_status: "local_only", source_mask: sourceMask })
              .where("app_id", "=", row.app_id)
              .compile(),
          );
          demoted += 1;
        } else if (row.ownership_status === "owned") {
          // Metadata, Tag, and Collection membership rows cascade with the Game.
          runSync(db, queryFor(db).deleteFrom("games").where("app_id", "=", row.app_id).compile());
          deleted += 1;
        } else {
          runSync(
            db,
            queryFor(db)
              .updateTable("games")
              .set({ source_mask: sourceMask })
              .where("app_id", "=", row.app_id)
              .compile(),
          );
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
