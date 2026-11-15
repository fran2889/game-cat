import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../../src/server/index.ts";
import { StartupError } from "../../src/server/errors.ts";
import {
  openAppDatabase,
  type AppDatabase,
  type OpenDatabaseOptions,
} from "../../src/server/db/database.ts";
import { loadMigrations } from "../../src/server/db/migrations.ts";

const CLIENT_DIR = join(import.meta.dirname, "..", "fixtures", "client");

const dirs: string[] = [];
const handles: AppDatabase[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
  while (handles.length > 0) {
    handles.pop()?.close();
  }
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-bootstrap-"));
  dirs.push(dir);
  return dir;
}

function database(dataDir: string, overrides: Partial<OpenDatabaseOptions> = {}): AppDatabase {
  const db = openAppDatabase({ dataDir, steamWebApiConfigured: false, ...overrides });
  handles.push(db);
  return db;
}

function serverOptions(dataDir: string) {
  return {
    dataDir,
    port: 0,
    openBrowser: false,
    env: {} as NodeJS.ProcessEnv,
    homedir: tempDir(),
    platform: "linux" as NodeJS.Platform,
    clientDir: CLIENT_DIR,
    logLevel: "error",
    logToStderr: false,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<StartupError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).code).toBe(code);
    return error as StartupError;
  }
  throw new Error("expected a StartupError");
}

function sourceRows(db: AppDatabase): Record<string, string> {
  const rows = db.raw
    .prepare("SELECT name, status FROM source_state ORDER BY name")
    .all() as Array<{
    name: string;
    status: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.name, row.status]));
}

describe("source_state seeding", () => {
  it("AC-S1 seeds the five sources as unknown and marks steam_web_api not configured", () => {
    const db = database(tempDir(), { steamWebApiConfigured: false });

    expect(sourceRows(db)).toEqual({
      steam_local: "unknown",
      steam_reviews: "unknown",
      steamspy: "unknown",
      steam_web_api: "not_configured",
      storefront: "unknown",
    });
  });

  it("leaves steam_web_api unknown when a key and SteamID64 are configured", () => {
    const db = database(tempDir(), { steamWebApiConfigured: true });
    expect(sourceRows(db).steam_web_api).toBe("unknown");
  });

  it("does not overwrite later source state on restart", () => {
    const dataDir = tempDir();
    const first = database(dataDir);
    first.raw
      .prepare("UPDATE source_state SET status = 'ok', last_success_at = 123 WHERE name = ?")
      .run("steam_web_api");
    first.raw.prepare("UPDATE source_state SET status = 'ok' WHERE name = ?").run("steamspy");
    first.close();
    handles.pop();

    const second = database(dataDir);
    const rows = sourceRows(second);
    expect(rows.steam_web_api).toBe("ok");
    expect(rows.steamspy).toBe("ok");
    expect(
      second.raw
        .prepare("SELECT last_success_at AS at FROM source_state WHERE name = ?")
        .get("steam_web_api"),
    ).toEqual({ at: 123 });
    expect(sourceRows(second).steam_local).toBe("unknown");
  });
});

describe("database startup integration", () => {
  it("AC-S1/AC-S2 GET /api/status reports schema version 1 from the applied database", async () => {
    const dataDir = tempDir();
    const server = await createServer(serverOptions(dataDir));
    servers.push(server);

    expect(existsSync(join(dataDir, "game-cat.sqlite"))).toBe(true);
    const response = await fetch(`${server.url}api/status`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { app: { dbSchemaVersion: number } } };
    expect(body.data.app.dbSchemaVersion).toBe(1);
  });

  it("AC-C12 DB_UNRECOGNIZED stops startup, releases the lock, and leaves the file alone", async () => {
    const dataDir = tempDir();
    mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, "game-cat.sqlite");
    const raw = new BetterSqlite3(path);
    raw.prepare("CREATE TABLE not_ours (id INTEGER PRIMARY KEY)").run();
    raw.close();
    const before = readFileSync(path);

    const error = await expectCode(createServer(serverOptions(dataDir)), "DB_UNRECOGNIZED");
    expect(error.message).toContain("schema_migrations");
    expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("AC-S3 DB_SCHEMA_TOO_NEW stops startup without modifying the file", async () => {
    const dataDir = tempDir();
    const db = database(dataDir);
    db.close();
    handles.pop();

    const path = join(dataDir, "game-cat.sqlite");
    const raw = new BetterSqlite3(path);
    raw
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(9, "future", 1);
    raw.pragma("user_version = 9");
    raw.close();
    const before = readFileSync(path);

    const error = await expectCode(createServer(serverOptions(dataDir)), "DB_SCHEMA_TOO_NEW");
    expect(error.message).toContain("9");
    expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("AC-S4 DB_MIGRATION_FAILED leaves the previous version and a pre-migration backup", async () => {
    const dataDir = tempDir();
    const db = database(dataDir);
    db.close();
    handles.pop();

    const failing = [
      ...loadMigrations(),
      {
        version: 2,
        name: "broken",
        sql: "CREATE TABLE broken (id INTEGER);\nINSERT INTO nope (id) VALUES (1);",
      },
    ];

    const error = await expectCode(
      createServer({
        ...serverOptions(dataDir),
        database: (options) => openAppDatabase({ ...options, migrations: failing }),
      }),
      "DB_MIGRATION_FAILED",
    );
    expect(error.details).toMatchObject({ version: 2, name: "broken" });
    expect(existsSync(join(dataDir, "game-cat.lock"))).toBe(false);

    expect(
      readdirSync(join(dataDir, "backups")).filter((name) =>
        /^game-cat\.pre-v2-\d+\.sqlite$/.test(name),
      ),
    ).toHaveLength(1);
  });

  it("DB_ACCOUNT_MISMATCH refuses a different selected Account without changing the binding", async () => {
    const dataDir = tempDir();
    const db = database(dataDir);
    db.raw
      .prepare("INSERT INTO account_state (singleton, steam_id64, bound_at) VALUES (1, ?, ?)")
      .run("76561198000000001", 1_700_000_000);
    db.close();
    handles.pop();
    const path = join(dataDir, "game-cat.sqlite");
    const before = readFileSync(path);

    const error = await expectCode(
      createServer({ ...serverOptions(dataDir), steamId64: "76561198000000002" }),
      "DB_ACCOUNT_MISMATCH",
    );
    expect(error.message).toContain("76561198000000001");
    expect(error.message).toContain("76561198000000002");
    expect(readFileSync(path).equals(before)).toBe(true);

    const reopened = openAppDatabase({ dataDir, steamWebApiConfigured: false });
    handles.push(reopened);
    expect(reopened.boundSteamId64).toBe("76561198000000001");
  });

  it("accepts the bound Account and reports it as ready", async () => {
    const dataDir = tempDir();
    const db = database(dataDir);
    db.raw
      .prepare("INSERT INTO account_state (singleton, steam_id64, bound_at) VALUES (1, ?, ?)")
      .run("76561198000000001", 1_700_000_000);
    db.close();
    handles.pop();

    const server = await createServer({
      ...serverOptions(dataDir),
      steamId64: "76561198000000001",
    });
    servers.push(server);
    expect((await fetch(`${server.url}api/status`)).status).toBe(200);
  });

  it("uses the injected database opener and closes it with the server", async () => {
    const dataDir = tempDir();
    const paths: string[] = [];
    let closed = false;

    const server = await createServer({
      ...serverOptions(dataDir),
      database: (options) => {
        const opened = openAppDatabase(options);
        paths.push(opened.path);
        return {
          ...opened,
          close() {
            closed = true;
            opened.close();
          },
        };
      },
    });
    servers.push(server);

    expect(paths).toEqual([join(dataDir, "game-cat.sqlite")]);
    const body = (await (await fetch(`${server.url}api/status`)).json()) as {
      data: { app: { dbSchemaVersion: number } };
    };
    expect(body.data.app.dbSchemaVersion).toBe(1);

    await server.close();
    servers.pop();
    expect(closed).toBe(true);
  });
});
