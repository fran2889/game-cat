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
  const dir = mkdtempSync(join(tmpdir(), "game-cat-collection-scan-db-"));
  dataDirs.push(dir);
  const db = openAppDatabase({ dataDir: dir, steamWebApiConfigured: false });
  databases.push(db);
  return db;
}

function scan(steam: SteamFixture, db: AppDatabase) {
  return scanLocalLibrary({
    db: db.raw,
    steamRoot: steam.root,
    steamId64: TEST_STEAM_ID64,
    now: () => 1_700_000_000,
  });
}

function gameRows(db: AppDatabase): Array<Record<string, unknown>> {
  return db.raw.prepare("SELECT * FROM games ORDER BY app_id").all() as Array<
    Record<string, unknown>
  >;
}

function collectionRows(db: AppDatabase): Array<Record<string, unknown>> {
  return db.raw.prepare("SELECT * FROM steam_collections ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
}

function memberRows(db: AppDatabase): Array<Record<string, unknown>> {
  return db.raw
    .prepare("SELECT * FROM steam_collection_games ORDER BY steam_collection_id, app_id")
    .all() as Array<Record<string, unknown>>;
}

function staticCollection(
  id: string,
  name: string,
  added: number[],
): { key: string; value: string } {
  return {
    key: `user-collections.${id}`,
    value: JSON.stringify({ name, added, removed: [] }),
  };
}

describe("Steam Collection scan integration", () => {
  it("mirrors static membership and creates Collection-only Games as unknown", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    steam.writeCloudStorage([
      staticCollection("favorite", "Favorites", [620, 730]),
      staticCollection("from-tag-492", "Indie", [730]),
    ]);
    const db = database();

    const result = scan(steam, db);

    expect(result.status).toBe("ok");
    expect(gameRows(db).map((row) => row.app_id)).toEqual([620, 730]);
    expect(gameRows(db)[0]).toMatchObject({
      ownership_status: "unknown",
      source_mask: 8,
    });
    expect(collectionRows(db)).toMatchObject([
      { id: "favorite", name: "Favorites", kind: "favorite", is_dynamic: 0 },
      { id: "from-tag-492", name: "Indie", kind: "tag", is_dynamic: 0 },
    ]);
    expect(memberRows(db)).toEqual([
      { steam_collection_id: "favorite", app_id: 620 },
      { steam_collection_id: "favorite", app_id: 730 },
      { steam_collection_id: "from-tag-492", app_id: 730 },
    ]);
  });

  it("promotes a Collection-only Game to local_only only when manifest or localconfig evidence appears", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    steam.writeCloudStorage([staticCollection("favorite", "Favorites", [620, 730])]);
    const db = database();

    scan(steam, db);
    expect(gameRows(db).map((row) => row.ownership_status)).toEqual(["unknown", "unknown"]);

    steam.writeManifest(steam.root, 620, { name: "Portal 2" });
    scan(steam, db);
    expect(gameRows(db).find((row) => row.app_id === 620)).toMatchObject({
      ownership_status: "local_only",
      source_mask: 10,
    });
    expect(gameRows(db).find((row) => row.app_id === 730)?.ownership_status).toBe("unknown");

    steam.writeLocalConfig({ "730": { playtime: 12 } });
    scan(steam, db);
    expect(gameRows(db).find((row) => row.app_id === 730)).toMatchObject({
      ownership_status: "local_only",
      source_mask: 12,
      local_playtime_minutes: 12,
    });
  });

  it("replaces membership, removes deleted Collections, and recomputes bit 8", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    steam.writeCloudStorage([
      staticCollection("favorite", "Favorites", [620]),
      staticCollection("uc-extra", "Extra", [730]),
    ]);
    const db = database();

    scan(steam, db);
    expect(collectionRows(db).map((row) => row.id)).toEqual(["favorite", "uc-extra"]);
    expect(memberRows(db)).toHaveLength(2);

    steam.writeCloudStorage([staticCollection("favorite", "Favorites renamed", [730])]);
    const result = scan(steam, db);

    expect(result.status).toBe("ok");
    // 620 lost its only evidence source on a fully successful scan.
    expect(gameRows(db).map((row) => row.app_id)).toEqual([730]);
    expect(gameRows(db)[0]).toMatchObject({ source_mask: 8, ownership_status: "unknown" });
    expect(collectionRows(db)).toMatchObject([{ id: "favorite", name: "Favorites renamed" }]);
    expect(memberRows(db)).toEqual([{ steam_collection_id: "favorite", app_id: 730 }]);
  });

  it("deletes a Collection-only Game when a later successful scan finds no Collections", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    steam.writeCloudStorage([staticCollection("favorite", "Favorites", [620])]);
    const db = database();

    scan(steam, db);
    expect(gameRows(db)).toHaveLength(1);

    steam.writeCloudStorage([]);
    const result = scan(steam, db);

    expect(result.status).toBe("ok");
    expect(gameRows(db)).toEqual([]);
    expect(collectionRows(db)).toEqual([]);
  });

  it("stores dynamic Collections as metadata with no membership rows", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    const filterSpec = { nFormatVersion: 2, filterGroups: [] };
    steam.writeCloudStorage([
      {
        key: "user-collections.uc-dynamic",
        value: JSON.stringify({
          name: "Action",
          added: [620],
          removed: [730],
          filterSpec,
        }),
      },
    ]);
    const db = database();

    scan(steam, db);

    expect(gameRows(db)).toEqual([]);
    expect(memberRows(db)).toEqual([]);
    expect(collectionRows(db)[0]).toMatchObject({
      id: "uc-dynamic",
      name: "Action",
      kind: "user",
      is_dynamic: 1,
    });
    expect(JSON.parse(collectionRows(db)[0]?.filter_spec_json as string)).toEqual(filterSpec);
    expect(JSON.parse(collectionRows(db)[0]?.raw_value_json as string)).toMatchObject({
      added: [620],
      removed: [730],
    });
  });

  it("replaces readable cloud storage on a partial scan, clears removed bit 8, and deletes nothing", () => {
    const steam = fixture();
    const second = steam.addLibrary("SecondLibrary");
    steam.writeManifest(second, 730, { name: "Unmounted Game" });
    steam.writeLocalConfig({});
    steam.writeCloudStorage([staticCollection("favorite", "Favorites", [620, 730])]);
    const db = database();
    scan(steam, db);
    expect(gameRows(db).find((row) => row.app_id === 730)?.source_mask).toBe(10);

    rmSync(second, { recursive: true, force: true });
    steam.writeCloudStorage([staticCollection("favorite", "Favorites", [620])]);
    const result = scan(steam, db);

    expect(result.status).toBe("partial");
    expect(gameRows(db).map((row) => row.app_id)).toEqual([620, 730]);
    expect(gameRows(db).find((row) => row.app_id === 730)).toMatchObject({
      source_mask: 2,
      installed: 1,
      library_path: second,
    });
    expect(memberRows(db)).toEqual([{ steam_collection_id: "favorite", app_id: 620 }]);
    expect(collectionRows(db)).toHaveLength(1);
  });

  it("preserves the whole mirror and bit 8 when cloud storage is unreadable", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    steam.writeCloudStorage([staticCollection("favorite", "Favorites", [620])]);
    const db = database();
    scan(steam, db);

    steam.writeRawCloudStorage("[{truncated");
    const result = scan(steam, db);

    expect(result.status).toBe("partial");
    expect(collectionRows(db)).toMatchObject([{ id: "favorite", name: "Favorites" }]);
    expect(memberRows(db)).toEqual([{ steam_collection_id: "favorite", app_id: 620 }]);
    expect(gameRows(db)[0]).toMatchObject({ source_mask: 8, ownership_status: "unknown" });
    expect(result.warnings.join("\n")).toContain("Could not parse");
  });
});
