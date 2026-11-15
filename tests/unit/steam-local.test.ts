import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSteamLocalLibrary } from "../../src/server/steam/local.ts";
import { SteamFixture, TEST_ACCOUNT_ID, TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

const fixtures: SteamFixture[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.dispose();
  }
});

function fixture(): SteamFixture {
  const value = new SteamFixture();
  fixtures.push(value);
  return value;
}

function snapshot(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = join(name.parentPath, name.name);
    entries.push(`${full}:${statSync(full).size}:${statSync(full).mtimeMs}`);
  }
  return entries.sort();
}

describe("Steam library folder discovery", () => {
  it("reads modern libraryfolders.vdf, includes the root, and de-duplicates by realpath", () => {
    const steam = fixture();
    const second = steam.addLibrary("SecondLibrary");
    steam.writeLibraryFolders();
    // A symlink to the root is a separate spelling of the same library.
    const link = steam.addSymlink();
    steam.writeRawLibraryFolders(`
      "libraryfolders"
      {
        "0" { "path" "${steam.root}" }
        "1" { "path" "${second}" }
        "2" { "path" "${link}" }
        "TimeNextStatsReport" "1"
      }
    `);

    const snapshotResult = readSteamLocalLibrary({
      steamRoot: steam.root,
      steamId64: TEST_STEAM_ID64,
    });

    expect(snapshotResult.found).toBe(true);
    expect(snapshotResult.libraries).toHaveLength(2);
    expect(snapshotResult.libraries.map((library) => library.realPath)).toEqual(
      expect.arrayContaining([steam.root, second]),
    );
    expect(snapshotResult.manifestsComplete).toBe(true);
  });

  it("accepts the legacy string form in steamapps/libraryfolders.vdf", () => {
    const steam = fixture();
    const second = steam.addLibrary("Legacy", { listed: false });
    steam.writeRawLibraryFolders(`"LibraryFolders" { "1" "${second}" }`, true);

    const result = readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });

    expect(result.libraries.map((library) => library.path)).toEqual(
      expect.arrayContaining([steam.root, second]),
    );
    expect(result.found).toBe(true);
  });

  it("treats a listed but unreadable library as partial and keeps the root", () => {
    const steam = fixture();
    const missing = join(steam.base, "UnmountedLibrary");
    steam.writeRawLibraryFolders(`
      "libraryfolders" { "0" { "path" "${steam.root}" } "1" { "path" "${missing}" } }
    `);

    const result = readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });

    expect(result.found).toBe(true);
    expect(result.manifestsComplete).toBe(false);
    expect(result.libraries.find((library) => library.path === missing)?.readable).toBe(false);
  });

  it("does not fall back when the configured root is not a Steam root", () => {
    const steam = fixture();
    const result = readSteamLocalLibrary({
      steamRoot: join(steam.base, "not-a-steam-root"),
      steamId64: TEST_STEAM_ID64,
    });
    expect(result.found).toBe(false);
    expect(result.libraries).toEqual([]);
  });
});

describe("appmanifest parsing", () => {
  it("reads manifest fields and passes the installed test", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, {
      name: "Portal 2",
      stateFlags: 4,
      installDir: "Portal 2",
      sizeOnDisk: 13200000000,
      lastUpdated: 1712000000,
      lastPlayed: 1712100000,
    });

    const result = readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });
    const manifest = result.manifests.find((entry) => entry.appId === 620);

    expect(manifest).toMatchObject({
      appId: 620,
      name: "Portal 2",
      stateFlags: 4,
      installDir: "Portal 2",
      installed: true,
      sizeOnDiskBytes: 13200000000,
      lastUpdatedAt: 1712000000,
      manifestLastPlayedAt: 1712100000,
      libraryPath: steam.root,
    });
    expect(result.manifestsComplete).toBe(true);
  });

  it("requires bit 4, an existing install directory, and a non-empty depot list", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 10, { stateFlags: 4 });
    steam.writeManifest(steam.root, 20, { stateFlags: 1026 });
    steam.writeManifest(steam.root, 30, { stateFlags: 4, createdInstallDir: false });
    steam.writeManifest(steam.root, 40, { stateFlags: 4, depots: null });
    steam.writeManifest(steam.root, 50, { stateFlags: 4 | 64 });

    const result = readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });
    const installed = new Map(result.manifests.map((entry) => [entry.appId, entry.installed]));

    expect(installed.get(10)).toBe(true);
    expect(installed.get(20)).toBe(false);
    expect(installed.get(30)).toBe(false);
    expect(installed.get(40)).toBe(false);
    expect(installed.get(50)).toBe(true);
  });

  it("rejects a manifest whose appid does not match its file name, and marks the scan partial", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, { appidOverride: 730 });

    const result = readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });

    expect(result.manifests).toEqual([]);
    expect(result.manifestsComplete).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toContain("manifest_appid_mismatch");
  });

  it("treats a truncated or rootless manifest as partial without crashing", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620);
    writeFileSync(
      join(steam.root, "steamapps", "appmanifest_730.acf"),
      '"AppState" { "appid" "730"',
    );
    writeFileSync(
      join(steam.root, "steamapps", "appmanifest_440.acf"),
      '"SomethingElse" { "appid" "440" }',
    );

    const result = readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });

    expect(result.manifests.map((entry) => entry.appId)).toEqual([620]);
    expect(result.manifestsComplete).toBe(false);
  });

  it("never opens Steam files for writing and creates nothing in the tree", () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, { name: "Portal 2" });
    steam.writeLocalConfig({ "620": { playtime: 612 } });
    const before = snapshot(steam.root);

    readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });

    expect(snapshot(steam.root)).toEqual(before);
    expect(readFileSync(join(steam.root, "steamapps", "appmanifest_620.acf"), "utf8")).toContain(
      "Portal 2",
    );
  });
});

describe("localconfig parsing", () => {
  it("reads playtime, recent playtime, and last played case-insensitively", () => {
    const steam = fixture();
    steam.writeRawLocalConfig(`
      "UserLocalConfigStore" {
        "Software" { "Valve" { "Steam" {
          "Apps" {
            "620" { "lastplayed" "1712100000" "PLAYTIME" "612" "playtime2wks" "45" }
            "730" { "playtime" "-5" "Playtime2wks" "0" }
          }
        } } }
      }
    `);

    const result = readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });

    expect(result.localConfigComplete).toBe(true);
    expect(result.accountId).toBe(TEST_ACCOUNT_ID);
    expect(result.localConfigEntries).toEqual([
      {
        appId: 620,
        playtimeMinutes: 612,
        playtime2weeksMinutes: 45,
        lastPlayedAt: 1712100000,
      },
      {
        appId: 730,
        playtimeMinutes: 0,
        playtime2weeksMinutes: 0,
        lastPlayedAt: null,
      },
    ]);
    expect(result.negativePlaytimeCount).toBe(1);
  });

  it("falls back to userdata/<steamId64> when the derived account folder is absent", () => {
    const steam = fixture();
    steam.writeLocalConfig({ "620": { playtime: 12 } }, TEST_STEAM_ID64);

    const result = readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });

    expect(result.localConfigComplete).toBe(true);
    expect(result.accountDir).toBe(join(steam.root, "userdata", TEST_STEAM_ID64));
  });

  it("reports an unreadable localconfig as null without clearing anything", () => {
    const steam = fixture();
    steam.writeRawLocalConfig('"UserLocalConfigStore" { "Software" { "Valve"');

    const result = readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });

    expect(result.localConfigEntries).toBeNull();
    expect(result.localConfigComplete).toBe(false);
  });

  it("treats a missing localconfig as unreadable, not empty", () => {
    const steam = fixture();
    const result = readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });
    expect(result.localConfigEntries).toBeNull();
    expect(result.localConfigComplete).toBe(false);
  });

  it("skips localconfig entirely when no Account is selected", () => {
    const steam = fixture();
    steam.writeLocalConfig({ "620": { playtime: 12 } });

    const result = readSteamLocalLibrary({ steamRoot: steam.root, steamId64: null });

    expect(result.accountId).toBeNull();
    expect(result.localConfigEntries).toBeNull();
  });
});
