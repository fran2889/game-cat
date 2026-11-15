import type BetterSqlite3 from "better-sqlite3";
import { normalizeNameKey } from "../../shared/names.ts";
import type { LocalLibrarySnapshot, LocalManifest, LocalPlaytimeEntry } from "../steam/local.ts";
import { readSteamLocalLibrary } from "../steam/local.ts";
import { readBoundSteamId64 } from "../db/database.ts";

/**
 * Local library scan and Game persistence (spec §2.1, §2.7, §6.10).
 *
 * The scan is deliberately conservative: a source that was not read completely
 * never clears evidence or deletes rows. Only a scan that read every library
 * and the Account's localconfig reconciles absent Games.
 */

export const SOURCE_MANIFEST = 2;
export const SOURCE_LOCALCONFIG = 4;
export const SOURCE_STEAM_COLLECTION = 8;
/** Any local evidence, excluding Ownership bit 1. */
export const LOCAL_EVIDENCE_MASK = SOURCE_MANIFEST | SOURCE_LOCALCONFIG | SOURCE_STEAM_COLLECTION;

export interface ScanWarningCounts {
  negativePlaytime: number;
}

export interface LibraryScanResult {
  status: "ok" | "partial" | "failed";
  error: { code: string; message: string } | null;
  /** Why an otherwise readable scan wrote nothing account-scoped. */
  skipped: "no_account" | null;
  stats: {
    libraries: number;
    manifests: number;
    localconfigApps: number;
    upserted: number;
    deleted: number;
    warnings: ScanWarningCounts;
  };
  warnings: string[];
}

export interface LibraryScanOptions {
  db: BetterSqlite3.Database;
  steamRoot: string | null;
  steamId64: string | null;
  now?: () => number;
  reader?: typeof readSteamLocalLibrary;
}

export class AccountMismatchError extends Error {
  readonly code = "ACCOUNT_MISMATCH";
  readonly boundSteamId64: string;

  constructor(boundSteamId64: string, selectedSteamId64: string) {
    super(
      `The database is bound to Steam Account ${boundSteamId64}, but the selected Account is ${selectedSteamId64}.`,
    );
    this.name = "AccountMismatchError";
    this.boundSteamId64 = boundSteamId64;
  }
}

interface GameRow {
  app_id: number;
  name: string;
  name_key: string;
  name_source: string;
  ownership_status: "owned" | "local_only" | "unknown";
  installed: number | null;
  library_path: string | null;
  install_dir: string | null;
  size_on_disk_bytes: number | null;
  state_flags: number | null;
  local_playtime_minutes: number | null;
  api_playtime_minutes: number | null;
  playtime_minutes: number;
  local_playtime_2weeks_minutes: number | null;
  api_playtime_2weeks_minutes: number | null;
  playtime_2weeks_minutes: number | null;
  manifest_last_played_at: number | null;
  localconfig_last_played_at: number | null;
  last_updated_at: number | null;
  source_mask: number;
  first_seen_at: number;
  last_seen_at: number;
}

interface PersistedGame {
  appId: number;
  name: string;
  nameKey: string;
  nameSource: string;
  ownershipStatus: GameRow["ownership_status"];
  installed: number | null;
  libraryPath: string | null;
  installDir: string | null;
  sizeOnDiskBytes: number | null;
  stateFlags: number | null;
  localPlaytimeMinutes: number | null;
  localPlaytime2weeksMinutes: number | null;
  manifestLastPlayedAt: number | null;
  localconfigLastPlayedAt: number | null;
  lastUpdatedAt: number | null;
  sourceMask: number;
  lastSeenAt: number;
}

const LOCAL_NAME_SOURCES = new Set(["placeholder", "steamspy", "local"]);

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Insert or check the single Account binding, without writing on mismatch. */
export function bindAccount(
  db: BetterSqlite3.Database,
  steamId64: string,
  now: () => number,
): void {
  const bound = readBoundSteamId64(db);
  if (bound === null) {
    db.prepare("INSERT INTO account_state (singleton, steam_id64, bound_at) VALUES (1, ?, ?)").run(
      steamId64,
      now(),
    );
    return;
  }
  if (bound !== steamId64) {
    throw new AccountMismatchError(bound, steamId64);
  }
}

function resolvePlaytime(local: number | null, api: number | null): number {
  return local ?? api ?? 0;
}

function resolveRecent(local: number | null, api: number | null): number | null {
  return local ?? api ?? null;
}

function emptyResult(
  status: LibraryScanResult["status"],
  stats: LibraryScanResult["stats"],
  extras: Partial<LibraryScanResult> = {},
): LibraryScanResult {
  return {
    status,
    error: null,
    skipped: null,
    stats,
    warnings: [],
    ...extras,
  };
}

const ZERO_STATS = (): LibraryScanResult["stats"] => ({
  libraries: 0,
  manifests: 0,
  localconfigApps: 0,
  upserted: 0,
  deleted: 0,
  warnings: { negativePlaytime: 0 },
});

export function scanLocalLibrary(options: LibraryScanOptions): LibraryScanResult {
  const now = options.now ?? unixSeconds;
  const reader = options.reader ?? readSteamLocalLibrary;

  if (options.steamRoot === null) {
    return emptyResult("failed", ZERO_STATS(), {
      error: {
        code: "STEAM_NOT_FOUND",
        message: "Steam was not found. Set a Steam folder before scanning.",
      },
    });
  }

  const snapshot = reader({
    steamRoot: options.steamRoot,
    steamId64: options.steamId64,
  });

  const stats = ZERO_STATS();
  stats.libraries = snapshot.libraries.length;
  stats.manifests = snapshot.manifests.length;
  stats.localconfigApps = snapshot.localConfigEntries?.length ?? 0;
  stats.warnings.negativePlaytime = snapshot.negativePlaytimeCount;
  const warnings = snapshot.warnings.map((warning) => warning.message);

  if (!snapshot.found) {
    return emptyResult("failed", stats, {
      warnings,
      error: {
        code: "STEAM_NOT_FOUND",
        message: `Steam was not found at ${snapshot.root}.`,
      },
    });
  }

  if (options.steamId64 === null) {
    return emptyResult("partial", stats, { warnings, skipped: "no_account" });
  }

  const bound = readBoundSteamId64(options.db);
  if (bound !== null && bound !== options.steamId64) {
    return emptyResult("failed", stats, {
      warnings,
      error: {
        code: "ACCOUNT_MISMATCH",
        message: `The database is bound to Steam Account ${bound}, but the selected Account is ${options.steamId64}.`,
      },
    });
  }

  const complete = snapshot.manifestsComplete && snapshot.localConfigComplete;

  const persist = options.db.transaction(() => {
    bindAccount(options.db, options.steamId64!, now);
    return persistSnapshot(options.db, snapshot, now(), stats);
  });
  const result = persist();
  stats.upserted = result.upserted;
  stats.deleted = result.deleted;

  return {
    status: complete ? "ok" : "partial",
    error: null,
    skipped: null,
    stats,
    warnings,
  };
}

function persistSnapshot(
  db: BetterSqlite3.Database,
  snapshot: LocalLibrarySnapshot,
  seenAt: number,
  stats: LibraryScanResult["stats"],
): { upserted: number; deleted: number } {
  const existingRows = db.prepare("SELECT * FROM games").all() as GameRow[];
  const existing = new Map(existingRows.map((row) => [row.app_id, row]));

  const manifests = new Map<number, LocalManifest>(
    snapshot.manifests.map((manifest) => [manifest.appId, manifest]),
  );
  const localEntries =
    snapshot.localConfigEntries === null
      ? null
      : new Map<number, LocalPlaytimeEntry>(
          snapshot.localConfigEntries.map((entry) => [entry.appId, entry]),
        );
  const manifestComplete = snapshot.manifestsComplete;
  const localComplete = snapshot.localConfigEntries !== null;

  const seen = new Set<number>([
    ...manifests.keys(),
    ...(localEntries === null ? [] : localEntries.keys()),
  ]);

  const upsert = db.prepare(`
    INSERT INTO games (
      app_id, name, name_key, name_source, ownership_status, installed,
      library_path, install_dir, size_on_disk_bytes, state_flags,
      local_playtime_minutes, local_playtime_2weeks_minutes,
      playtime_minutes, playtime_2weeks_minutes,
      manifest_last_played_at, localconfig_last_played_at, last_updated_at,
      source_mask, first_seen_at, last_seen_at
    ) VALUES (
      @appId, @name, @nameKey, @nameSource, @ownershipStatus, @installed,
      @libraryPath, @installDir, @sizeOnDiskBytes, @stateFlags,
      @localPlaytimeMinutes, @localPlaytime2weeksMinutes,
      @playtimeMinutes, @playtime2weeksMinutes,
      @manifestLastPlayedAt, @localconfigLastPlayedAt, @lastUpdatedAt,
      @sourceMask, @seenAt, @seenAt
    )
    ON CONFLICT(app_id) DO UPDATE SET
      name = excluded.name,
      name_key = excluded.name_key,
      name_source = excluded.name_source,
      ownership_status = excluded.ownership_status,
      installed = excluded.installed,
      library_path = excluded.library_path,
      install_dir = excluded.install_dir,
      size_on_disk_bytes = excluded.size_on_disk_bytes,
      state_flags = excluded.state_flags,
      local_playtime_minutes = excluded.local_playtime_minutes,
      local_playtime_2weeks_minutes = excluded.local_playtime_2weeks_minutes,
      playtime_minutes = excluded.playtime_minutes,
      playtime_2weeks_minutes = excluded.playtime_2weeks_minutes,
      manifest_last_played_at = excluded.manifest_last_played_at,
      localconfig_last_played_at = excluded.localconfig_last_played_at,
      last_updated_at = excluded.last_updated_at,
      source_mask = excluded.source_mask,
      last_seen_at = excluded.last_seen_at
  `);

  const updateUnseen = db.prepare(`
    UPDATE games SET
      installed = @installed,
      library_path = @libraryPath,
      install_dir = @installDir,
      size_on_disk_bytes = @sizeOnDiskBytes,
      state_flags = @stateFlags,
      local_playtime_minutes = @localPlaytimeMinutes,
      local_playtime_2weeks_minutes = @localPlaytime2weeksMinutes,
      playtime_minutes = @playtimeMinutes,
      playtime_2weeks_minutes = @playtime2weeksMinutes,
      manifest_last_played_at = @manifestLastPlayedAt,
      localconfig_last_played_at = @localconfigLastPlayedAt,
      last_updated_at = @lastUpdatedAt,
      source_mask = @sourceMask
    WHERE app_id = @appId
  `);
  const remove = db.prepare("DELETE FROM games WHERE app_id = ?");

  let upserted = 0;
  for (const appId of [...seen].sort((left, right) => left - right)) {
    const row = existing.get(appId);
    const manifest = manifests.get(appId);
    const local = localEntries?.get(appId);

    let sourceMask = row?.source_mask ?? 0;
    if (manifest !== undefined) {
      sourceMask |= SOURCE_MANIFEST;
    } else if (manifestComplete) {
      sourceMask &= ~SOURCE_MANIFEST;
    }
    if (local !== undefined) {
      sourceMask |= SOURCE_LOCALCONFIG;
    } else if (localComplete) {
      sourceMask &= ~SOURCE_LOCALCONFIG;
    }

    const localEvidence = (sourceMask & LOCAL_EVIDENCE_MASK) !== 0;
    const ownershipStatus: GameRow["ownership_status"] =
      row === undefined
        ? localEvidence
          ? "local_only"
          : "unknown"
        : row.ownership_status === "unknown" && localEvidence
          ? "local_only"
          : row.ownership_status;

    const localPlaytime =
      local !== undefined
        ? local.playtimeMinutes
        : localComplete
          ? null
          : (row?.local_playtime_minutes ?? null);
    const localRecent =
      local !== undefined
        ? local.playtime2weeksMinutes
        : localComplete
          ? null
          : (row?.local_playtime_2weeks_minutes ?? null);
    const apiPlaytime = row?.api_playtime_minutes ?? null;
    const apiRecent = row?.api_playtime_2weeks_minutes ?? null;

    const next: PersistedGame = {
      appId,
      ...nameFor(row, manifest?.name ?? null, appId),
      ownershipStatus,
      installed:
        manifest !== undefined
          ? manifest.installed
            ? 1
            : 0
          : manifestComplete
            ? 0
            : (row?.installed ?? null),
      libraryPath:
        manifest !== undefined
          ? manifest.libraryPath
          : manifestComplete
            ? null
            : (row?.library_path ?? null),
      installDir:
        manifest !== undefined
          ? manifest.installDir
          : manifestComplete
            ? null
            : (row?.install_dir ?? null),
      sizeOnDiskBytes:
        manifest !== undefined
          ? manifest.sizeOnDiskBytes
          : manifestComplete
            ? null
            : (row?.size_on_disk_bytes ?? null),
      stateFlags:
        manifest !== undefined
          ? manifest.stateFlags
          : manifestComplete
            ? null
            : (row?.state_flags ?? null),
      localPlaytimeMinutes: localPlaytime,
      localPlaytime2weeksMinutes: localRecent,
      manifestLastPlayedAt:
        manifest !== undefined
          ? manifest.manifestLastPlayedAt
          : manifestComplete
            ? null
            : (row?.manifest_last_played_at ?? null),
      localconfigLastPlayedAt:
        local !== undefined
          ? local.lastPlayedAt
          : localComplete
            ? null
            : (row?.localconfig_last_played_at ?? null),
      lastUpdatedAt:
        manifest !== undefined
          ? manifest.lastUpdatedAt
          : manifestComplete
            ? null
            : (row?.last_updated_at ?? null),
      sourceMask,
      lastSeenAt: seenAt,
    };

    upsert.run({
      ...next,
      playtimeMinutes: resolvePlaytime(localPlaytime, apiPlaytime),
      playtime2weeksMinutes: resolveRecent(localRecent, apiRecent),
      seenAt,
    });
    upserted += 1;
  }

  let deleted = 0;
  for (const row of existingRows) {
    if (seen.has(row.app_id)) {
      continue;
    }
    if (!manifestComplete && !localComplete) {
      continue;
    }

    let sourceMask = row.source_mask;
    let installed = row.installed;
    let libraryPath = row.library_path;
    let installDir = row.install_dir;
    let sizeOnDiskBytes = row.size_on_disk_bytes;
    let stateFlags = row.state_flags;
    let manifestLastPlayedAt = row.manifest_last_played_at;
    let lastUpdatedAt = row.last_updated_at;
    let localPlaytime = row.local_playtime_minutes;
    let localRecent = row.local_playtime_2weeks_minutes;
    let localconfigLastPlayedAt = row.localconfig_last_played_at;

    if (manifestComplete) {
      sourceMask &= ~SOURCE_MANIFEST;
      installed = 0;
      libraryPath = null;
      installDir = null;
      sizeOnDiskBytes = null;
      stateFlags = null;
      manifestLastPlayedAt = null;
      lastUpdatedAt = null;
    }
    if (localComplete) {
      sourceMask &= ~SOURCE_LOCALCONFIG;
      localPlaytime = null;
      localRecent = null;
      localconfigLastPlayedAt = null;
    }

    // Deletion requires a fully successful scan; a partial scan never deletes.
    if (
      manifestComplete &&
      localComplete &&
      (sourceMask & LOCAL_EVIDENCE_MASK) === 0 &&
      row.ownership_status !== "owned"
    ) {
      remove.run(row.app_id);
      deleted += 1;
      continue;
    }

    updateUnseen.run({
      appId: row.app_id,
      installed,
      libraryPath,
      installDir,
      sizeOnDiskBytes,
      stateFlags,
      localPlaytimeMinutes: localPlaytime,
      localPlaytime2weeksMinutes: localRecent,
      playtimeMinutes: resolvePlaytime(localPlaytime, row.api_playtime_minutes),
      playtime2weeksMinutes: resolveRecent(localRecent, row.api_playtime_2weeks_minutes),
      manifestLastPlayedAt,
      localconfigLastPlayedAt,
      lastUpdatedAt,
      sourceMask,
    });
  }

  return { upserted, deleted };
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
    return { name: trimmed, nameKey: normalizeNameKey(trimmed), nameSource: "local" };
  }

  if (trimmed === "" || !LOCAL_NAME_SOURCES.has(row.name_source)) {
    return { name: row.name, nameKey: row.name_key, nameSource: row.name_source };
  }

  return { name: trimmed, nameKey: normalizeNameKey(trimmed), nameSource: "local" };
}
