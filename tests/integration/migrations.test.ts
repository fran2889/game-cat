import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StartupError } from "../../src/server/errors.ts";
import { DB_SCHEMA_VERSION } from "../../src/shared/app.ts";
import { openAppDatabase, type AppDatabase } from "../../src/server/db/database.ts";
import { loadMigrations, type Migration } from "../../src/server/db/migrations.ts";

const dirs: string[] = [];
const open: AppDatabase[] = [];

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-db-"));
  dirs.push(dir);
  return dir;
}

function database(dataDir: string, overrides: Partial<Parameters<typeof openAppDatabase>[0]> = {}) {
  const db = openAppDatabase({ dataDir, steamWebApiConfigured: false, ...overrides });
  open.push(db);
  return db;
}

function raw(path: string): Database.Database {
  return new Database(path);
}

function insertGame(db: Database.Database, appId = 10): void {
  db.prepare(
    "INSERT INTO games (app_id, name, name_key, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run(appId, `Game ${appId}`, `game-${appId}`, 1_700_000_000, 1_700_000_000);
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function indexNames(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function viewNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function startupCode(fn: () => unknown): StartupError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StartupError);
    return error as StartupError;
  }
  throw new Error("expected a StartupError");
}

describe("migration 0001", () => {
  it("AC-S1 applies a fresh database and records version 1", () => {
    const dataDir = tempDir();
    const db = database(dataDir);

    expect(db.schemaVersion).toBe(1);
    expect(DB_SCHEMA_VERSION).toBe(loadMigrations().at(-1)?.version);
    expect(db.raw.pragma("user_version", { simple: true })).toBe(1);

    const rows = db.raw
      .prepare("SELECT version, name, applied_at FROM schema_migrations")
      .all() as Array<{
      version: number;
      name: string;
      applied_at: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
    expect(rows[0]?.name).toBe("initial");
    expect(rows[0]?.applied_at).toBeGreaterThan(1_600_000_000);
    expect(Number.isInteger(rows[0]?.applied_at)).toBe(true);
    expect(existsSync(join(dataDir, "game-cat.sqlite"))).toBe(true);
  });

  it("AC-S2 creates every table, index, and v_games and sets the connection pragmas", () => {
    const dataDir = tempDir();
    const db = database(dataDir);

    expect(tableNames(db.raw).sort()).toEqual(
      [
        "schema_migrations",
        "account_state",
        "games",
        "steamspy_appdetails",
        "storefront_appdetails",
        "steam_review_summaries",
        "tags",
        "game_tags",
        "steam_collections",
        "steam_collection_games",
        "smart_collections",
        "rules",
        "refresh_runs",
        "source_state",
      ].sort(),
    );

    expect(indexNames(db.raw).sort()).toEqual(
      [
        "idx_games_name",
        "idx_games_ownership",
        "idx_games_installed",
        "idx_games_playtime",
        "idx_game_tags_tag",
        "idx_steam_collection_games",
        "idx_steam_collections_name",
        "idx_refresh_runs_started",
        "idx_refresh_runs_running",
        "idx_steamspy_tags_status",
        "idx_storefront_release",
        "idx_storefront_metacritic",
        "idx_storefront_status",
        "idx_steam_reviews_status",
        "idx_steam_reviews_total",
      ].sort(),
    );
    expect(viewNames(db.raw)).toEqual(["v_games"]);

    expect(db.raw.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.raw.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.raw.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.raw.pragma("synchronous", { simple: true })).toBe(1);
  });

  it("AC-S8 has no game_enrichment table and keys every Metadata table by app_id", () => {
    const db = database(tempDir());

    expect(tableNames(db.raw)).not.toContain("game_enrichment");
    for (const table of [
      "steamspy_appdetails",
      "storefront_appdetails",
      "steam_review_summaries",
    ]) {
      const columns = db.raw.pragma(`table_info(${table})`) as Array<{
        name: string;
        pk: number;
      }>;
      expect(columns.find((column) => column.name === "app_id")?.pk).toBe(1);
      const foreignKeys = db.raw.pragma(`foreign_key_list(${table})`) as Array<{
        table: string;
        from: string;
        on_delete: string;
      }>;
      expect(foreignKeys).toContainEqual(
        expect.objectContaining({ table: "games", from: "app_id", on_delete: "CASCADE" }),
      );
    }
  });

  it("AC-S5 cascades a Smart Collection's Rules and a Game's dependent rows", () => {
    const db = database(tempDir());
    const rawDb = db.raw;

    rawDb
      .prepare(
        "INSERT INTO smart_collections (id, name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("sc-1", "Favourites", "favourites", 1, 1);
    rawDb
      .prepare(
        "INSERT INTO rules (smart_collection_id, position, prefix, field, operator, value_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("sc-1", 0, "AND", "installed", "is", "true");
    rawDb
      .prepare(
        "INSERT INTO rules (smart_collection_id, position, prefix, field, operator, value_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("sc-1", 1, "OR", "tags", "contains", '"Roguelike"');

    rawDb.prepare("DELETE FROM smart_collections WHERE id = ?").run("sc-1");
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM rules").get()).toEqual({ n: 0 });

    insertGame(rawDb);
    rawDb.prepare("INSERT INTO steamspy_appdetails (app_id, updated_at) VALUES (?, ?)").run(10, 1);
    rawDb
      .prepare("INSERT INTO storefront_appdetails (app_id, updated_at) VALUES (?, ?)")
      .run(10, 1);
    rawDb
      .prepare("INSERT INTO steam_review_summaries (app_id, updated_at) VALUES (?, ?)")
      .run(10, 1);
    rawDb
      .prepare("INSERT INTO tags (id, name, name_key) VALUES (?, ?, ?)")
      .run(1, "Action", "action");
    rawDb.prepare("INSERT INTO game_tags (app_id, tag_id, votes) VALUES (?, ?, ?)").run(10, 1, 5);
    rawDb
      .prepare(
        "INSERT INTO steam_collections (id, name, kind, raw_value_json, imported_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("favorite", "Favourites", "favorite", "{}", 1);
    rawDb
      .prepare("INSERT INTO steam_collection_games (steam_collection_id, app_id) VALUES (?, ?)")
      .run("favorite", 10);

    rawDb.prepare("DELETE FROM games WHERE app_id = ?").run(10);

    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM steamspy_appdetails").get()).toEqual({ n: 0 });
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM storefront_appdetails").get()).toEqual({
      n: 0,
    });
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM steam_review_summaries").get()).toEqual({
      n: 0,
    });
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM game_tags").get()).toEqual({ n: 0 });
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM steam_collection_games").get()).toEqual({
      n: 0,
    });
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM tags").get()).toEqual({ n: 1 });
  });

  it("AC-S6 rejects invalid refresh, source, installed, and review values", () => {
    const db = database(tempDir());
    const rawDb = db.raw;
    insertGame(rawDb);

    const insertRun = rawDb.prepare(
      "INSERT INTO refresh_runs (scope, mode, status, started_at, app_ids_json) VALUES (?, ?, ?, ?, ?)",
    );
    const valid: Array<[string, string | null, string | null]> = [
      ["library", null, null],
      ["ownership", null, null],
      ["all", "fetch", null],
      ["metadata", "fetch", null],
      ["metadata", "full", "[10]"],
    ];
    for (const [scope, mode, appIds] of valid) {
      expect(() => insertRun.run(scope, mode, "queued", 1, appIds)).not.toThrow();
    }

    const invalid: Array<[string, string | null, string | null, string]> = [
      ["library", "fetch", null, "library with a mode"],
      ["ownership", null, "[10]", "ownership with a selection"],
      ["all", "full", null, "all with full"],
      ["all", "fetch", "[10]", "all with a selection"],
      ["metadata", "full", null, "metadata full without a selection"],
      ["metadata", "fetch", "[10]", "metadata fetch with a selection"],
      ["unknown", null, null, "unknown scope"],
    ];
    for (const [scope, mode, appIds, label] of invalid) {
      expect(() => insertRun.run(scope, mode, "queued", 1, appIds), label).toThrow();
    }

    expect(() =>
      rawDb
        .prepare("INSERT INTO source_state (name, status) VALUES (?, 'unknown')")
        .run("not_a_source"),
    ).toThrow();
    expect(() =>
      rawDb
        .prepare("INSERT INTO source_state (name, status) VALUES ('steamspy', 'nonsense')")
        .run(),
    ).toThrow();
    expect(() => rawDb.prepare("UPDATE games SET installed = 2 WHERE app_id = 10").run()).toThrow();
    expect(() =>
      rawDb.prepare("UPDATE games SET installed = 'yes' WHERE app_id = 10").run(),
    ).toThrow();

    rawDb
      .prepare("INSERT INTO steam_review_summaries (app_id, updated_at) VALUES (?, ?)")
      .run(10, 1);
    expect(() =>
      rawDb
        .prepare(
          "UPDATE steam_review_summaries SET review_positive = 5, review_negative = 3, review_total = 9 WHERE app_id = 10",
        )
        .run(),
    ).toThrow("CHECK constraint failed");
    expect(() =>
      rawDb
        .prepare(
          "UPDATE steam_review_summaries SET review_positive = 5, review_negative = NULL, review_total = 5 WHERE app_id = 10",
        )
        .run(),
    ).toThrow("CHECK constraint failed");
    expect(() =>
      rawDb
        .prepare(
          "UPDATE steam_review_summaries SET review_positive = 5, review_negative = 3, review_total = 8 WHERE app_id = 10",
        )
        .run(),
    ).not.toThrow();
  });

  it("AC-S7 returns missing metadata, empty arrays, a null platform, and a computed review score", () => {
    const db = database(tempDir());
    const rawDb = db.raw;
    insertGame(rawDb, 10);
    insertGame(rawDb, 20);

    const missing = rawDb.prepare("SELECT * FROM v_games WHERE app_id = 10").get() as Record<
      string,
      unknown
    >;
    expect(missing.tags_status).toBe("missing");
    expect(missing.store_status).toBe("missing");
    expect(missing.review_status).toBe("missing");
    expect(missing.developers_json).toBe("[]");
    expect(missing.publishers_json).toBe("[]");
    expect(missing.genres_json).toBe("[]");
    expect(missing.categories_json).toBe("[]");
    expect(missing.platforms_json).toBeNull();
    expect(missing.review_score).toBeNull();
    expect(missing.last_played_at).toBeNull();
    expect(missing.release_year).toBeNull();
    expect(missing.metacritic_score).toBeNull();

    rawDb
      .prepare(
        `INSERT INTO storefront_appdetails
           (app_id, genres_json, categories_json, platforms_json, release_year, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(10, '["Action"]', '["Single-player"]', '{"windows":true}', 1998, 1);
    rawDb
      .prepare(
        "INSERT INTO steam_review_summaries (app_id, review_positive, review_negative, review_total, review_status, updated_at) VALUES (?, ?, ?, ?, 'ok', ?)",
      )
      .run(10, 95, 5, 100, 1);
    rawDb
      .prepare(
        "INSERT INTO steam_review_summaries (app_id, review_positive, review_negative, review_total, review_status, updated_at) VALUES (?, ?, ?, ?, 'ok', ?)",
      )
      .run(20, 2, 1, 3, 1);
    rawDb
      .prepare(
        "UPDATE games SET manifest_last_played_at = 100, localconfig_last_played_at = 200, installed = 0 WHERE app_id = 10",
      )
      .run();

    const known = rawDb.prepare("SELECT * FROM v_games WHERE app_id = 10").get() as Record<
      string,
      unknown
    >;
    expect(known.genres_json).toBe('["Action"]');
    expect(known.platforms_json).toBe('{"windows":true}');
    expect(known.review_score).toBe(95);
    expect(known.last_played_at).toBe(200);
    expect(known.installed).toBe(0);

    const rounded = rawDb.prepare("SELECT review_score FROM v_games WHERE app_id = 20").get() as {
      review_score: number;
    };
    expect(rounded.review_score).toBe(67);
  });

  it("exposes the games column contract from §3.3", () => {
    const db = database(tempDir());
    const columns = db.raw.pragma("table_info(games)") as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    expect(
      columns.map(({ name, type, notnull, dflt_value, pk }) => ({
        name,
        type,
        notnull,
        dflt_value,
        pk,
      })),
    ).toEqual([
      { name: "app_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "name_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "name_source", type: "TEXT", notnull: 1, dflt_value: "'placeholder'", pk: 0 },
      { name: "ownership_status", type: "TEXT", notnull: 1, dflt_value: "'unknown'", pk: 0 },
      { name: "installed", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "library_path", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "install_dir", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "size_on_disk_bytes", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "state_flags", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "local_playtime_minutes", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "api_playtime_minutes", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "playtime_minutes", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      {
        name: "local_playtime_2weeks_minutes",
        type: "INTEGER",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      { name: "api_playtime_2weeks_minutes", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "playtime_2weeks_minutes", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "manifest_last_played_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "localconfig_last_played_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "last_updated_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "source_mask", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
      { name: "first_seen_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "last_seen_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    ]);
  });
});

describe("migration runner", () => {
  it("AC-S3 refuses a database newer than the bundle without changing the file", () => {
    const dataDir = tempDir();
    const path = join(dataDir, "game-cat.sqlite");
    const first = database(dataDir);
    first.close();
    open.pop();

    const newer = raw(path);
    newer
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(2, "future", 1_700_000_000);
    newer.pragma("user_version = 2");
    newer.close();

    const before = readFileSync(path);
    const error = startupCode(() => openAppDatabase({ dataDir, steamWebApiConfigured: false }));
    expect(error.code).toBe("DB_SCHEMA_TOO_NEW");
    expect(error.message).toContain("2");
    expect(error.message).toContain("1");
    expect(error.details).toMatchObject({ databaseVersion: 2, bundledVersion: 1 });
    expect(readFileSync(path).equals(before)).toBe(true);

    const reopened = raw(path);
    expect(reopened.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
      v: 2,
    });
    reopened.close();
  });

  it("AC-S4 rolls back a failing migration, keeps the data, and keeps the backup", () => {
    const dataDir = tempDir();
    const bundle = loadMigrations();
    const first = database(dataDir, { migrations: bundle });
    insertGame(first.raw);
    first.close();
    open.pop();

    const failing: Migration[] = [
      ...bundle,
      {
        version: 2,
        name: "broken",
        sql: "CREATE TABLE broken (id INTEGER);\nINSERT INTO missing_table (id) VALUES (1);",
      },
    ];

    const error = startupCode(() =>
      openAppDatabase({ dataDir, steamWebApiConfigured: false, migrations: failing }),
    );
    expect(error.code).toBe("DB_MIGRATION_FAILED");
    expect(error.message).toContain("2");
    expect(error.details).toMatchObject({ version: 2, name: "broken" });

    const data = raw(join(dataDir, "game-cat.sqlite"));
    expect(data.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({ v: 1 });
    expect(data.pragma("user_version", { simple: true })).toBe(1);
    expect(data.prepare("SELECT COUNT(*) AS n FROM games").get()).toEqual({ n: 1 });
    expect(
      data.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'broken'").get(),
    ).toBeUndefined();
    data.close();

    const backups = readdirSync(join(dataDir, "backups")).filter((name) =>
      /^game-cat\.pre-v2-\d+\.sqlite$/.test(name),
    );
    expect(backups).toHaveLength(1);
    const backup = raw(join(dataDir, "backups", backups[0]!));
    expect(backup.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()).toEqual({
      v: 1,
    });
    expect(backup.prepare("SELECT COUNT(*) AS n FROM games").get()).toEqual({ n: 1 });
    backup.close();
  });

  it("keeps the last three pre-migration backups after a successful start", () => {
    const dataDir = tempDir();
    const db = database(dataDir);
    db.close();
    open.pop();

    const backupsDir = join(dataDir, "backups");
    mkdirSync(backupsDir, { recursive: true });
    for (const epoch of [100, 101, 102, 103, 104]) {
      writeFileSync(join(backupsDir, `game-cat.pre-v1-${epoch}.sqlite`), "old");
    }

    database(dataDir);

    expect(readdirSync(backupsDir).sort()).toEqual([
      "game-cat.pre-v1-102.sqlite",
      "game-cat.pre-v1-103.sqlite",
      "game-cat.pre-v1-104.sqlite",
    ]);
  });

  it("refuses an unknown schema with user tables and leaves it untouched", () => {
    const dataDir = tempDir();
    const path = join(dataDir, "game-cat.sqlite");
    const unknown = raw(path);
    unknown.prepare("CREATE TABLE someone_elses_data (id INTEGER PRIMARY KEY)").run();
    unknown.close();
    const before = readFileSync(path);

    const error = startupCode(() => openAppDatabase({ dataDir, steamWebApiConfigured: false }));
    expect(error.code).toBe("DB_UNRECOGNIZED");
    expect(readFileSync(path).equals(before)).toBe(true);

    const reopened = raw(path);
    expect(tableNames(reopened)).toEqual(["someone_elses_data"]);
    reopened.close();
  });
});
