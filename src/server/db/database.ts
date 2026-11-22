import { mkdirSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { SOURCE_ORDER } from "../../shared/types.ts";
import { StartupError } from "../errors.ts";
import { runMigrations, type MigrateResult } from "./migrate.ts";
import { loadMigrations, type Migration } from "./migrations.ts";
import { firstSync, queryFor } from "./query.ts";

export interface OpenDatabaseOptions {
  /** The data directory; the database lives at `<data-dir>/game-cat.sqlite`. */
  dataDir: string;
  /** A key and a SteamID64 are both required for ownership requests. */
  steamWebApiConfigured: boolean;
  /** The selected Account, if discovery or configuration found one. */
  selectedSteamId64?: string | null;
  /** Test seam for an alternate bundled migration set. */
  migrations?: readonly Migration[];
  /** Test seam for deterministic `applied_at` and backup names. */
  now?: () => number;
  keepBackups?: number;
}

/**
 * The open database shared by startup and (from later tickets) repositories.
 * `raw` is the single better-sqlite3 connection; `close()` is idempotent so the
 * startup cleanup path and `RunningServer.close()` can both call it.
 */
export interface AppDatabase {
  readonly path: string;
  readonly schemaVersion: number;
  readonly boundSteamId64: string | null;
  readonly raw: BetterSqlite3.Database;
  close(): void;
}

/** Injectable database boundary for `createServer`. */
export type OpenDatabase = (options: OpenDatabaseOptions) => AppDatabase;

export function databasePath(dataDir: string): string {
  return join(dataDir, "game-cat.sqlite");
}

export function backupsPath(dataDir: string): string {
  return join(dataDir, "backups");
}

/**
 * Open `<data-dir>/game-cat.sqlite`, run the bundled migrations, seed the five
 * source rows, and enforce the Account guard from §3.2. Every failure closes
 * the connection and throws a `StartupError`.
 */
export function openAppDatabase(options: OpenDatabaseOptions): AppDatabase {
  const path = databasePath(options.dataDir);
  const migrations = options.migrations ?? loadMigrations();
  const selected = options.selectedSteamId64 ?? null;

  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });

  let raw: BetterSqlite3.Database | null = null;
  try {
    raw = new BetterSqlite3(path);
    const result: MigrateResult = runMigrations({
      db: raw,
      databasePath: path,
      migrations,
      backupDir: backupsPath(options.dataDir),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.keepBackups === undefined ? {} : { keepBackups: options.keepBackups }),
    });

    const boundSteamId64 = readBoundSteamId64(raw);
    assertAccountBinding(path, boundSteamId64, selected);
    seedSourceState(raw, options.steamWebApiConfigured);

    let closed = false;
    const connection = raw;
    return {
      path,
      schemaVersion: result.schemaVersion,
      boundSteamId64,
      raw: connection,
      close() {
        if (!closed) {
          closed = true;
          connection.close();
        }
      },
    };
  } catch (error) {
    try {
      raw?.close();
    } catch {
      // Best effort while unwinding a failed open.
    }
    throw error;
  }
}

/**
 * Insert the five `source_state` rows once. This is idempotent and never
 * overwrites a later status: only the `unknown` placeholder is promoted to
 * `not_configured` when ownership cannot be configured.
 */
export function seedSourceState(db: BetterSqlite3.Database, steamWebApiConfigured: boolean): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO source_state (name, status) VALUES (?, 'unknown')",
  );
  db.transaction(() => {
    for (const name of SOURCE_ORDER) {
      insert.run(name);
    }
    if (!steamWebApiConfigured) {
      db.prepare(
        "UPDATE source_state SET status = 'not_configured' WHERE name = 'steam_web_api' AND status = 'unknown'",
      ).run();
    }
  })();
}

export function readBoundSteamId64(db: BetterSqlite3.Database): string | null {
  const row = firstSync<{ steam_id64: string }>(
    db,
    queryFor(db)
      .selectFrom("account_state")
      .select("steam_id64")
      .where("singleton", "=", 1)
      .compile(),
  );
  return row?.steam_id64 ?? null;
}

function assertAccountBinding(
  path: string,
  boundSteamId64: string | null,
  selectedSteamId64: string | null,
): void {
  if (boundSteamId64 === null || selectedSteamId64 === null) {
    return;
  }
  if (boundSteamId64 !== selectedSteamId64) {
    throw new StartupError(
      "DB_ACCOUNT_MISMATCH",
      `The database is bound to Steam Account ${boundSteamId64}, but the selected Account is ` +
        `${selectedSteamId64}. Use the matching Account or a new data directory.`,
      { details: { databasePath: path, boundSteamId64, selectedSteamId64 } },
    );
  }
}
