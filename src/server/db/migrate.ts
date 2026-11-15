import { chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { StartupError } from "../errors.ts";
import { highestBundledVersion, type Migration } from "./migrations.ts";

const CREATE_SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
)`;

/** Keep this many pre-migration backups (§3.2 step 8). */
export const KEEP_BACKUPS = 3;

const BACKUP_PATTERN = /^game-cat\.pre-v(\d+)-(\d+)\.sqlite$/;

export interface MigrateOptions {
  db: BetterSqlite3.Database;
  /** Path of the main database file, used only for diagnostics. */
  databasePath: string;
  migrations: readonly Migration[];
  backupDir: string;
  now?: () => number;
  keepBackups?: number;
}

export interface MigrateResult {
  schemaVersion: number;
  applied: number[];
  backupPath: string | null;
  fresh: boolean;
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Apply the forward-only migration bundle per §3.2.
 *
 * Compatibility checks happen before the persistent `journal_mode = WAL`
 * setting, so `DB_UNRECOGNIZED` and `DB_SCHEMA_TOO_NEW` never rewrite the
 * file. Each numbered migration runs in its own `BEGIN IMMEDIATE` transaction.
 */
export function runMigrations(options: MigrateOptions): MigrateResult {
  const { migrations, databasePath } = options;
  const sqlite = options.db;
  const now = options.now ?? unixSeconds;
  const keepBackups = options.keepBackups ?? KEEP_BACKUPS;

  // These pragmas are connection-local (or a no-op) and do not touch the file.
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");

  const tables = (
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);

  const hasMigrationsTable = tables.includes("schema_migrations");
  const userTables = tables.filter((name) => name !== "schema_migrations");

  let currentVersion: number;
  let fresh = false;

  if (!hasMigrationsTable) {
    if (userTables.length > 0) {
      throw new StartupError(
        "DB_UNRECOGNIZED",
        `${databasePath} has user tables but no schema_migrations table. ` +
          `Refusing to guess at an unknown schema; move the file away to start fresh.`,
        { details: { databasePath, tables: userTables } },
      );
    }
    sqlite.exec(CREATE_SCHEMA_MIGRATIONS);
    currentVersion = 0;
    fresh = true;
  } else {
    const row = sqlite
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get() as { version: number };
    currentVersion = row.version;
  }

  const targetVersion = highestBundledVersion(migrations);
  if (currentVersion > targetVersion) {
    throw new StartupError(
      "DB_SCHEMA_TOO_NEW",
      `${databasePath} has schema version ${currentVersion}, but this app bundles ` +
        `schema version ${targetVersion}. Update game-cat instead of downgrading the database.`,
      { details: { databasePath, databaseVersion: currentVersion, bundledVersion: targetVersion } },
    );
  }

  // Only now is the database known to be one this app can write.
  sqlite.pragma("journal_mode = WAL");

  const pending = migrations.filter((migration) => migration.version > currentVersion);
  let backupPath: string | null = null;

  if (pending.length > 0) {
    if (currentVersion > 0) {
      backupPath = createBackup(sqlite, options.backupDir, pending.at(-1)!.version, now());
    }

    for (const migration of pending) {
      applyMigration(sqlite, migration, currentVersion, now);
    }
  }

  const schemaVersion = pending.at(-1)?.version ?? currentVersion;
  pruneBackups(options.backupDir, keepBackups);

  return {
    schemaVersion,
    applied: pending.map((migration) => migration.version),
    backupPath,
    fresh,
  };
}

function applyMigration(
  db: BetterSqlite3.Database,
  migration: Migration,
  previousVersion: number,
  now: () => number,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
      migration.version,
      migration.name,
      now(),
    );
    db.pragma(`user_version = ${migration.version}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already have been rolled back by SQLite.
    }
    throw new StartupError(
      "DB_MIGRATION_FAILED",
      `Migration ${migration.version} (${migration.name}) failed. The database remains at ` +
        `schema version ${previousVersion} and any pre-migration backup remains for recovery: ` +
        `${(error as Error).message}`,
      {
        cause: error,
        details: { version: migration.version, name: migration.name, previousVersion },
      },
    );
  }
}

function nextBackupPath(backupDir: string, targetVersion: number, epoch: number): string {
  let candidate = epoch;
  let path = join(backupDir, `game-cat.pre-v${targetVersion}-${candidate}.sqlite`);
  while (existsSync(path)) {
    candidate += 1;
    path = join(backupDir, `game-cat.pre-v${targetVersion}-${candidate}.sqlite`);
  }
  return path;
}

/** A consistent copy, including committed WAL content (§3.2 step 6). */
function createBackup(
  db: BetterSqlite3.Database,
  backupDir: string,
  targetVersion: number,
  epoch: number,
): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const path = nextBackupPath(backupDir, targetVersion, epoch);
  const escaped = path.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
  }
  return path;
}

function pruneBackups(backupDir: string, keep: number): void {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return;
  }

  const backups = names
    .map((name) => {
      const match = BACKUP_PATTERN.exec(name);
      return match === null
        ? null
        : { name, version: Number.parseInt(match[1]!, 10), epoch: Number.parseInt(match[2]!, 10) };
    })
    .filter((entry): entry is { name: string; version: number; epoch: number } => entry !== null)
    .sort((left, right) => right.epoch - left.epoch || right.name.localeCompare(left.name));

  for (const backup of backups.slice(keep)) {
    try {
      unlinkSync(join(backupDir, backup.name));
    } catch {
      // Retention is best effort; a locked backup must not block startup.
    }
  }
}
