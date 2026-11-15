import { afterEach, describe, expect, it } from "vitest";
import { readSteamLocalLibrary } from "../../src/server/steam/local.ts";
import { SteamFixture, TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

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

function read(steam: SteamFixture) {
  return readSteamLocalLibrary({ steamRoot: steam.root, steamId64: TEST_STEAM_ID64 });
}

function inner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "Favorites", added: [], removed: [], ...overrides };
}

describe("Steam Collection cloud storage", () => {
  it("merges the base and overlay by key, double-decodes values, and drops tombstones", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    steam.writeCloudStorage([
      {
        key: "user-collections.favorite",
        value: JSON.stringify(inner({ name: "Favorites", added: [620] })),
      },
      {
        key: "user-collections.from-tag-492",
        // Double encoded, as some Steam builds store it.
        value: JSON.stringify(JSON.stringify(inner({ name: "Indie", added: [730] }))),
      },
      {
        key: "user-collections.uc-old",
        value: JSON.stringify(inner({ name: "Old", added: [10] })),
      },
      {
        key: "UserLocalConfigStore",
        value: JSON.stringify({ not: "a collection" }),
      },
    ]);
    steam.writeCloudStorage(
      [
        {
          key: "user-collections.favorite",
          value: JSON.stringify(inner({ name: "Favorites", added: [620, 730] })),
        },
        {
          key: "user-collections.hidden",
          value: JSON.stringify(inner({ name: "Hidden", added: [730] })),
        },
        { key: "user-collections.uc-old", isDeleted: true },
      ],
      { overlay: true },
    );

    const result = read(steam);

    expect(result.collectionsComplete).toBe(true);
    expect(result.collections?.map((collection) => collection.id)).toEqual([
      "favorite",
      "from-tag-492",
      "hidden",
    ]);
    expect(result.collections?.find((collection) => collection.id === "favorite")?.added).toEqual([
      620, 730,
    ]);
    expect(
      result.collections?.find((collection) => collection.id === "from-tag-492")?.added,
    ).toEqual([730]);
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "collection_value_invalid",
    );
  });

  it("stores static `added`, drops invalid and duplicate members, and ignores `removed`", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    steam.writeCloudStorage([
      {
        key: "user-collections.uc-static",
        value: JSON.stringify(
          inner({ name: "Static", added: [620, 620, 0, -1, "730", 730], removed: [730, 10] }),
        ),
      },
    ]);

    const collection = read(steam).collections?.[0];

    expect(collection).toMatchObject({
      id: "uc-static",
      kind: "user",
      isDynamic: false,
      added: [620, 730],
    });
    expect(JSON.parse(collection!.rawValueJson)).toMatchObject({ removed: [730, 10] });
  });

  it("detects dynamic Collections from a version 2 filterSpec and stores no membership", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    const filterSpec = {
      nFormatVersion: 2,
      strSearchText: "",
      filterGroups: [{ rgOptions: [19], bAcceptUnion: false }],
    };
    steam.writeCloudStorage([
      {
        key: "user-collections.uc-dynamic",
        value: JSON.stringify(
          inner({ name: "Action", added: [620, 730], removed: [10], filterSpec }),
        ),
      },
      {
        key: "user-collections.uc-version1",
        value: JSON.stringify(
          inner({ name: "Future", added: [570], filterSpec: { nFormatVersion: 3 } }),
        ),
      },
    ]);

    const result = read(steam);
    const dynamic = result.collections?.find((collection) => collection.id === "uc-dynamic");
    const version1 = result.collections?.find((collection) => collection.id === "uc-version1");

    expect(dynamic).toMatchObject({ isDynamic: true, added: [], kind: "user" });
    expect(JSON.parse(dynamic!.filterSpecJson!)).toEqual(filterSpec);
    expect(JSON.parse(dynamic!.rawValueJson)).toMatchObject({ added: [620, 730], removed: [10] });
    expect(version1).toMatchObject({ isDynamic: false, added: [570] });
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "collection_filter_spec_unsupported",
    );
  });

  it("derives every kind from the key suffix and keeps duplicate names", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    steam.writeCloudStorage(
      ["favorite", "hidden", "uc-one", "from-tag-492", "type-1", "something-else"].map((id) => ({
        key: `user-collections.${id}`,
        value: JSON.stringify(inner({ name: "Same name", added: [] })),
      })),
    );

    const kinds = new Map(
      read(steam).collections?.map((collection) => [collection.id, collection.kind]),
    );

    expect(kinds.get("favorite")).toBe("favorite");
    expect(kinds.get("hidden")).toBe("hidden");
    expect(kinds.get("uc-one")).toBe("user");
    expect(kinds.get("from-tag-492")).toBe("tag");
    expect(kinds.get("type-1")).toBe("system");
    expect(kinds.get("something-else")).toBe("other");
    expect(read(steam).collections?.every((collection) => collection.name === "Same name")).toBe(
      true,
    );
  });

  it("falls back to the id for a name and skips only a malformed entry value", () => {
    const steam = fixture();
    steam.writeLocalConfig({});
    steam.writeCloudStorage([
      { key: "user-collections.uc-good", value: JSON.stringify({ added: [620] }) },
      { key: "user-collections.uc-bad", value: "{not json" },
    ]);

    const result = read(steam);

    expect(result.collectionsComplete).toBe(true);
    expect(result.collections?.map((collection) => collection.id)).toEqual(["uc-good"]);
    expect(result.collections?.[0]?.name).toBe("uc-good");
    expect(result.warnings.map((warning) => warning.code)).toContain("collection_value_invalid");
  });

  it("treats a missing cloud-storage file as an empty, successfully read mirror", () => {
    const steam = fixture();
    steam.writeLocalConfig({});

    const result = read(steam);

    expect(result.collections).toEqual([]);
    expect(result.collectionsComplete).toBe(true);
  });

  it("reports a malformed base or overlay as incomplete so the mirror can be preserved", () => {
    const malformedBase = fixture();
    malformedBase.writeLocalConfig({});
    malformedBase.writeRawCloudStorage("[{not: json");

    expect(read(malformedBase).collections).toBeNull();
    expect(read(malformedBase).collectionsComplete).toBe(false);

    const malformedOverlay = fixture();
    malformedOverlay.writeLocalConfig({});
    malformedOverlay.writeCloudStorage([
      { key: "user-collections.favorite", value: JSON.stringify(inner()) },
    ]);
    malformedOverlay.writeRawCloudStorage("{", { overlay: true });

    expect(read(malformedOverlay).collections).toBeNull();
    expect(read(malformedOverlay).collectionsComplete).toBe(false);
  });

  it("leaves the collection reader incomplete when no Account directory exists", () => {
    const steam = fixture();
    const result = read(steam);
    expect(result.collections).toBeNull();
    expect(result.collectionsComplete).toBe(false);
  });

  it("detects a file that changes on every read attempt as incomplete", async () => {
    const { readStable } = await import("../../src/server/steam/read-stable.ts");
    const steam = fixture();
    const path = steam.writeRawCloudStorage("[]");
    const warnings: Array<{ code: string; message: string; path?: string }> = [];
    let stat = 0;
    const io = {
      statSync: () => ({ mtimeMs: (stat += 1), size: 2 }),
      readFileSync: () => "[]",
    };

    expect(readStable(path, warnings, 3, io)).toBeNull();
    expect(warnings.map((warning) => warning.code)).toContain("file_changed_during_read");
  });
});
