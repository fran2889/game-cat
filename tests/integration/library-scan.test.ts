import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../../src/server/db/database.ts";
import { scanLocalLibrary } from "../../src/server/library/scan.ts";
import { SteamFixture, TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

const fixtures: SteamFixture[] = [];
const dataDirs: string[] = [];
const databases: AppDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (fixtures.length > 0) {
    fixtures.pop()?.dispose();
  }
  while (dataDirs.length > 0) {
    rmSync(dataDirs.pop()!, { recursive: true, force: true });
  }
});

function fixture(): SteamFixture {
  const value = new SteamFixture();
  fixtures.push(value);
  return value;
}

function database(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-scan-db-"));
  dataDirs.push(dir);
  const db = openAppDatabase({ dataDir: dir, steamWebApiConfigured: false });
  databases.push(db);
  return db;
}

function scan(
  fixtureValue: SteamFixture,
  db: AppDatabase,
  options: { steamId64?: string | null; now?: () => number } = {},
) {
  return scanLocalLibrary({
    db: db.raw,
    steamRoot: fixtureValue.root,
    steamId64: options.steamId64 === undefined ? TEST_STEAM_ID64 : options.steamId64,
    now: options.now ?? (() => 1_700_000_000),
  });
}

function games(db: AppDatabase): Array<Record<string, unknown>> {
  return db.raw.prepare("SELECT * FROM games ORDER BY app_id").all() as Array<
    Record<string, unknown>
  >;
}

describe("local library scan persistence", () => {
  it("upserts manifests and localconfig, records evidence bits, and binds the Account", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, {
      name: "Portal 2",
      sizeOnDisk: 13200000000,
      lastUpdated: 1712000000,
      lastPlayed: 1712100000,
    });
    steam.writeLocalConfig({
      "620": { playtime: 612, playtime2wks: 45, lastPlayed: 1712200000 },
      "730": { playtime: 30 },
    });
    const db = database();

    const result = scan(steam, db);

    expect(result.status).toBe("ok");
    expect(result.stats).toMatchObject({
      libraries: 1,
      manifests: 1,
      localconfigApps: 2,
      upserted: 2,
      deleted: 0,
      warnings: { negativePlaytime: 0 },
    });
    expect(games(db)).toHaveLength(2);

    const portal = games(db).find((row) => row.app_id === 620)!;
    expect(portal).toMatchObject({
      name: "Portal 2",
      name_key: "portal 2",
      name_source: "local",
      ownership_status: "local_only",
      installed: 1,
      library_path: steam.root,
      install_dir: "App 620",
      size_on_disk_bytes: 13200000000,
      state_flags: 4,
      local_playtime_minutes: 612,
      local_playtime_2weeks_minutes: 45,
      playtime_minutes: 612,
      playtime_2weeks_minutes: 45,
      manifest_last_played_at: 1712100000,
      localconfig_last_played_at: 1712200000,
      last_updated_at: 1712000000,
      source_mask: 6,
    });
    const localOnly = games(db).find((row) => row.app_id === 730)!;
    expect(localOnly).toMatchObject({
      name: "Game 730",
      name_source: "placeholder",
      ownership_status: "local_only",
      installed: 0,
      source_mask: 4,
    });

    expect(db.raw.prepare("SELECT steam_id64 FROM account_state").get()).toEqual({
      steam_id64: TEST_STEAM_ID64,
    });
  });

  it("uses the manifest name over the placeholder and recomputes name_key on rename", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, { name: "Portal 2" });
    const db = database();
    scan(steam, db);

    steam.writeManifest(steam.root, 620, { name: "Portal 2 RTX" });
    scan(steam, db);

    expect(games(db)[0]).toMatchObject({
      name: "Portal 2 RTX",
      name_key: "portal 2 rtx",
      name_source: "local",
    });
  });

  it("never overwrites a storefront name with a local name", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, { name: "Local Name" });
    const db = database();
    db.raw
      .prepare(
        `INSERT INTO games (app_id, name, name_key, name_source, ownership_status, first_seen_at, last_seen_at)
         VALUES (620, 'Storefront Name', 'storefront name', 'storefront', 'owned', 1, 1)`,
      )
      .run();

    scan(steam, db);

    expect(games(db)[0]).toMatchObject({
      name: "Storefront Name",
      name_key: "storefront name",
      name_source: "storefront",
      ownership_status: "owned",
    });
  });

  it("clamps negative playtime and records the warning count", () => {
    const steam = fixture();
    steam.writeLocalConfig({ "730": { playtime: -5, playtime2wks: -2 } });
    const db = database();

    const result = scan(steam, db);

    expect(result.status).toBe("ok");
    expect(result.stats.warnings.negativePlaytime).toBe(2);
    expect(games(db)[0]).toMatchObject({
      local_playtime_minutes: 0,
      local_playtime_2weeks_minutes: 0,
      playtime_minutes: 0,
      playtime_2weeks_minutes: 0,
    });
  });

  it("updates a later library's path and installed state", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, { name: "Portal 2" });
    const db = database();
    scan(steam, db);

    const second = steam.addLibrary("SecondLibrary");
    const db2 = database();
    scan(steam, db2);
    expect(games(db2)[0]?.library_path).toBe(steam.root);

    // Move the manifest to the second library and scan again.
    rmSync(join(steam.root, "steamapps", "appmanifest_620.acf"));
    steam.writeManifest(second, 620, { name: "Portal 2" });
    scan(steam, db2);
    expect(games(db2)[0]).toMatchObject({ library_path: second, installed: 1 });
  });

  it("keeps first_seen_at and API playtime across a rescan", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, { name: "Portal 2" });
    steam.writeLocalConfig({});
    const db = database();
    scan(steam, db, { now: () => 1_000 });

    expect(games(db)[0]).toMatchObject({
      first_seen_at: 1_000,
      last_seen_at: 1_000,
      api_playtime_minutes: null,
    });

    db.raw
      .prepare("UPDATE games SET api_playtime_minutes = 42, api_playtime_2weeks_minutes = 7")
      .run();
    scan(steam, db, { now: () => 2_000 });

    expect(games(db)[0]).toMatchObject({
      first_seen_at: 1_000,
      last_seen_at: 2_000,
      api_playtime_minutes: 42,
      api_playtime_2weeks_minutes: 7,
      playtime_minutes: 42,
      playtime_2weeks_minutes: 7,
    });
  });
});

describe("scan reconciliation", () => {
  function seedOwned(db: AppDatabase, appId: number, ownership = "owned"): void {
    db.raw
      .prepare(
        `INSERT INTO games (
           app_id, name, name_key, name_source, ownership_status, installed,
           library_path, install_dir, size_on_disk_bytes, state_flags,
           local_playtime_minutes, local_playtime_2weeks_minutes, playtime_minutes,
           playtime_2weeks_minutes, manifest_last_played_at, localconfig_last_played_at,
           last_updated_at, source_mask, first_seen_at, last_seen_at
         ) VALUES (?, 'Old', 'old', 'local', ?, 1, '/old', 'Old', 10, 4, 600, 30, 600, 30, 1700000000, 1700000001, 1600000000, 6, 1, 1)`,
      )
      .run(appId, ownership);
  }

  it("clears manifest fields and falls back playtime and last played on a full scan", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    const db = database();
    seedOwned(db, 620);
    db.raw
      .prepare("UPDATE games SET api_playtime_minutes = 42, api_playtime_2weeks_minutes = 7")
      .run();

    const result = scan(steam, db);

    expect(result.status).toBe("ok");
    expect(games(db)[0]).toMatchObject({
      ownership_status: "owned",
      installed: 0,
      library_path: null,
      install_dir: null,
      size_on_disk_bytes: null,
      state_flags: null,
      manifest_last_played_at: null,
      localconfig_last_played_at: null,
      last_updated_at: null,
      local_playtime_minutes: null,
      local_playtime_2weeks_minutes: null,
      playtime_minutes: 42,
      playtime_2weeks_minutes: 7,
      source_mask: 0,
    });
    const view = db.raw
      .prepare("SELECT installed, last_played_at FROM v_games WHERE app_id = 620")
      .get();
    expect(view).toEqual({ installed: 0, last_played_at: null });
  });

  it("clears local playtime for a Game absent from a fully read localconfig", () => {
    const steam = fixture();
    steam.writeLocalConfig({ "730": { playtime: 10 } });
    const db = database();
    seedOwned(db, 620);
    db.raw
      .prepare("UPDATE games SET api_playtime_minutes = 42, api_playtime_2weeks_minutes = 7")
      .run();

    scan(steam, db);

    expect(games(db).find((row) => row.app_id === 620)).toMatchObject({
      local_playtime_minutes: null,
      local_playtime_2weeks_minutes: null,
      localconfig_last_played_at: null,
      playtime_minutes: 42,
      playtime_2weeks_minutes: 7,
      source_mask: 0,
    });
  });

  it("deletes a non-owned row when every local bit is gone on a successful scan", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    const db = database();
    seedOwned(db, 620, "local_only");
    db.raw
      .prepare(
        `INSERT INTO games (app_id, name, name_key, name_source, ownership_status, first_seen_at, last_seen_at)
         VALUES (731, 'Collection only', 'collection only', 'placeholder', 'unknown', 1, 1)`,
      )
      .run();
    db.raw.prepare("UPDATE games SET source_mask = 8 WHERE app_id = 731").run();

    scan(steam, db);

    // No cloud-storage Collections exist, so the stale bit 8 is cleared and the
    // unknown row has no remaining evidence.
    expect(games(db)).toEqual([]);
  });

  it("preserves unseen evidence on a partial scan and deletes nothing", () => {
    const steam = fixture();
    const second = steam.addLibrary("SecondLibrary");
    steam.writeManifest(second, 730, { name: "Unreadable Library Game" });
    const db = database();
    seedOwned(db, 620, "local_only");

    // Unmount the second library after its manifest was recorded.
    rmSync(second, { recursive: true, force: true });

    const result = scan(steam, db);

    expect(result.status).toBe("partial");
    expect(games(db)).toHaveLength(1);
    expect(games(db)[0]).toMatchObject({
      app_id: 620,
      installed: 1,
      library_path: "/old",
      install_dir: "Old",
      state_flags: 4,
      manifest_last_played_at: 1700000000,
      source_mask: 6,
    });
  });

  it("updates readable evidence on a partial scan but keeps local playtime when localconfig is unreadable", () => {
    const steam = fixture();
    const second = steam.addLibrary("SecondLibrary");
    steam.writeManifest(steam.root, 620, { name: "Portal 2" });
    steam.writeRawLocalConfig('"UserLocalConfigStore" { "Software"');
    const db = database();
    seedOwned(db, 620, "local_only");
    steam.writeManifest(second, 730);
    rmSync(second, { recursive: true, force: true });

    const result = scan(steam, db);

    expect(result.status).toBe("partial");
    expect(games(db)[0]).toMatchObject({
      local_playtime_minutes: 600,
      local_playtime_2weeks_minutes: 30,
      localconfig_last_played_at: 1700000001,
      source_mask: 6,
      installed: 1,
    });
  });
});

describe("account handling", () => {
  it("writes nothing account-scoped and reports a partial run when no Account is selected", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620);
    steam.writeLocalConfig({ "620": { playtime: 10 } });
    const db = database();

    const result = scan(steam, db, { steamId64: null });

    expect(result.status).toBe("partial");
    expect(result.skipped).toBe("no_account");
    expect(games(db)).toEqual([]);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM account_state").get()).toEqual({
      count: 0,
    });
  });

  it("refuses to write under a different Account and leaves rows intact", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620);
    const db = database();
    scan(steam, db);

    const result = scan(steam, db, { steamId64: "76561198000000001" });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ACCOUNT_MISMATCH");
    expect(games(db)).toHaveLength(1);
  });

  it("fails without writes when Steam is missing", () => {
    const steam = fixture();
    const db = database();
    rmSync(steam.root, { recursive: true, force: true });

    const result = scan(steam, db);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("STEAM_NOT_FOUND");
    expect(games(db)).toEqual([]);
  });
});
