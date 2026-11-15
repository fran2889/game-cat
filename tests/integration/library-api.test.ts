import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../../src/server/db/database.ts";
import { createHttpApp } from "../../src/server/http/app.ts";
import { SteamCollectionsRepository } from "../../src/server/library/collections.ts";
import { GamesRepository } from "../../src/server/library/games.ts";
import { RulePreviewRepository } from "../../src/server/library/rule-preview.ts";
import { SmartCollectionsRepository } from "../../src/server/library/smart-collections.ts";
import { RuleValuesRepository } from "../../src/server/library/rule-values.ts";
import { TagsRepository } from "../../src/server/library/tags.ts";
import { RefreshService } from "../../src/server/refresh/service.ts";
import { buildStatus } from "../../src/server/status.ts";
import type { SteamDiscovery } from "../../src/server/steam/discovery.ts";
import type { GameDetail, GameSummary, RefreshRun, Status } from "../../src/shared/types.ts";
import { SteamFixture, TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;

const fixtures: SteamFixture[] = [];
const dataDirs: string[] = [];
const databases: AppDatabase[] = [];
const apps: Array<ReturnType<typeof createHttpApp>> = [];
const refreshes = new WeakMap<object, RefreshService>();

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
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

const discovery: SteamDiscovery = {
  root: "/fixture/Steam",
  state: "ready",
  accounts: [{ steamId64: TEST_STEAM_ID64, accountId: "39734272", personaName: "Player One" }],
  account: {
    steamId64: TEST_STEAM_ID64,
    accountId: "39734272",
    personaName: "Player One",
  },
  error: null,
};

interface Harness {
  db: AppDatabase;
  steam: SteamFixture;
  app: ReturnType<typeof createHttpApp>;
  refresh: RefreshService;
}

function harness(steam = fixture()): Harness {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-api-db-"));
  dataDirs.push(dir);
  const db = openAppDatabase({ dataDir: dir, steamWebApiConfigured: false });
  databases.push(db);
  const games = new GamesRepository(db.raw);
  const collections = new SteamCollectionsRepository(db.raw);
  const tags = new TagsRepository(db.raw);
  const refresh = new RefreshService({
    db: db.raw,
    steamRoot: steam.root,
    steamId64: TEST_STEAM_ID64,
    now: () => 1_700_000_000,
  });
  const app = createHttpApp({
    port: PORT,
    clientDir: null,
    logger: pino({ level: "silent" }),
    status: () =>
      buildStatus({
        discovery: { ...discovery, root: steam.root },
        steamApiKey: null,
        configuredSteamId64: TEST_STEAM_ID64,
        schemaVersion: db.schemaVersion,
        db: db.raw,
      }),
    library: {
      games,
      collections,
      ruleValues: new RuleValuesRepository(db.raw),
      rulePreview: new RulePreviewRepository(db.raw),
      smartCollections: new SmartCollectionsRepository(db.raw),
      tags,
      refresh,
    },
  });
  apps.push(app);
  refreshes.set(app, refresh);
  return { db, steam, app, refresh };
}

async function get(app: Harness["app"], url: string) {
  return app.inject({ method: "GET", url, headers: { host: HOST } });
}

async function post(app: Harness["app"], url: string, payload: object) {
  const response = await app.inject({ method: "POST", url, headers: { host: HOST }, payload });
  if (url === "/api/refresh" && response.statusCode === 202) {
    await refreshes.get(app)?.waitForIdle();
  }
  return response;
}

function seedGame(
  db: AppDatabase,
  appId: number,
  fields: {
    name?: string;
    installed?: number | null;
    playtime?: number;
    lastPlayed?: number | null;
    releaseYear?: number | null;
    metacritic?: number | null;
    ownership?: string;
  } = {},
): void {
  db.raw
    .prepare(
      `INSERT INTO games (
         app_id, name, name_key, name_source, ownership_status, installed,
         playtime_minutes, manifest_last_played_at, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, 'local', ?, ?, ?, ?, 1, 1)`,
    )
    .run(
      appId,
      fields.name ?? `Game ${appId}`,
      (fields.name ?? `Game ${appId}`).toLowerCase(),
      fields.ownership ?? "owned",
      fields.installed === undefined ? 0 : fields.installed,
      fields.playtime ?? 0,
      fields.lastPlayed ?? null,
    );
  if (fields.releaseYear !== undefined || fields.metacritic !== undefined) {
    db.raw
      .prepare(
        `INSERT INTO storefront_appdetails (
           app_id, release_year, metacritic_score, updated_at
         ) VALUES (?, ?, ?, 1)`,
      )
      .run(appId, fields.releaseYear ?? null, fields.metacritic ?? null);
  }
}

describe("POST /api/refresh (library)", () => {
  it("runs the local scan, returns 202 with the RefreshRun shape and Location", async () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, { name: "Portal 2" });
    steam.writeLocalConfig({ "620": { playtime: 612, lastPlayed: 1712100000 } });
    const test = harness(steam);

    const response = await post(test.app, "/api/refresh", { scope: "library" });

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toMatch(/^\/api\/refresh\/\d+$/);
    const started = response.json() as { data: RefreshRun };
    expect(started.data).toMatchObject({
      scope: "library",
      mode: null,
      status: expect.stringMatching(/^(queued|running)$/),
      appIds: null,
      stats: null,
      error: null,
    });
    expect(started.data.id).toBe(response.headers.location?.split("/").at(-1));

    const run = await get(test.app, `/api/refresh/${started.data.id}`);
    expect(run.statusCode).toBe(200);
    const body = run.json() as { data: RefreshRun };
    expect(body.data).toMatchObject({
      scope: "library",
      mode: null,
      status: "succeeded",
      total: 1,
      done: 1,
      appIds: null,
      stats: null,
      error: null,
    });
    expect(body.data.finishedAt).not.toBeNull();

    const unknown = await get(test.app, "/api/refresh/999");
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");

    const row = test.db.raw
      .prepare("SELECT scope, mode, status, stats_json FROM refresh_runs WHERE id = ?")
      .get(body.data.id) as {
      scope: string;
      mode: string | null;
      status: string;
      stats_json: string;
    };
    expect(row.scope).toBe("library");
    expect(row.mode).toBeNull();
    expect(row.status).toBe("succeeded");
    expect(JSON.parse(row.stats_json)).toMatchObject({
      libraries: 1,
      manifests: 1,
      localconfigApps: 1,
      upserted: 1,
      deleted: 0,
      warnings: { negativePlaytime: 0 },
    });
  });

  it("records negative playtime on the run without failing it", async () => {
    const steam = fixture();
    steam.writeLocalConfig({ "730": { playtime: -5 } });
    const test = harness(steam);

    const response = await post(test.app, "/api/refresh", { scope: "library" });
    expect(response.statusCode).toBe(202);

    const row = test.db.raw
      .prepare("SELECT stats_json FROM refresh_runs ORDER BY id DESC LIMIT 1")
      .get() as { stats_json: string };
    expect(JSON.parse(row.stats_json).warnings.negativePlaytime).toBe(1);
  });

  it("marks the run partial when no Account is selected and writes no Game rows", async () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620);
    const test = harness(steam);
    const refresh = new RefreshService({
      db: test.db.raw,
      steamRoot: steam.root,
      steamId64: null,
      now: () => 1_700_000_000,
    });
    const app = createHttpApp({
      port: PORT,
      clientDir: null,
      logger: pino({ level: "silent" }),
      status: () => ({}) as Status,
      library: {
        games: new GamesRepository(test.db.raw),
        collections: new SteamCollectionsRepository(test.db.raw),
        ruleValues: new RuleValuesRepository(test.db.raw),
        rulePreview: new RulePreviewRepository(test.db.raw),
        smartCollections: new SmartCollectionsRepository(test.db.raw),
        tags: new TagsRepository(test.db.raw),
        refresh,
      },
    });

    const response = await post(app, "/api/refresh", { scope: "library" });
    const started = response.json() as { data: RefreshRun };
    await refresh.waitForIdle();
    const finished = (await get(app, `/api/refresh/${started.data.id}`)).json() as {
      data: RefreshRun;
    };
    expect(finished.data.status).toBe("partial");
    expect(finished.data.error).toBeNull();
    expect(test.db.raw.prepare("SELECT COUNT(*) AS count FROM games").get()).toEqual({ count: 0 });
    await app.close();
  });

  it("rejects invalid combinations and accepts the documented scopes", async () => {
    const test = harness();

    const withMode = await post(test.app, "/api/refresh", { scope: "library", mode: "fetch" });
    expect(withMode.statusCode).toBe(422);
    expect(
      (withMode.json() as { error: { details: { fieldErrors: object } } }).error.details
        .fieldErrors,
    ).toHaveProperty("mode");

    const withAppIds = await post(test.app, "/api/refresh", { scope: "library", appIds: [1] });
    expect(withAppIds.statusCode).toBe(422);

    const unconfiguredOwnership = await post(test.app, "/api/refresh", { scope: "ownership" });
    expect(unconfiguredOwnership.statusCode).toBe(409);
    expect((unconfiguredOwnership.json() as { error: { code: string } }).error.code).toBe(
      "OWNERSHIP_NOT_CONFIGURED",
    );

    const metadata = await post(test.app, "/api/refresh", { scope: "metadata", mode: "fetch" });
    expect(metadata.statusCode).toBe(202);

    const all = await post(test.app, "/api/refresh", { scope: "all", mode: "fetch" });
    expect(all.statusCode).toBe(202);

    const missing = await post(test.app, "/api/refresh", {});
    expect(missing.statusCode).toBe(422);
  });
});

describe("GET /api/games", () => {
  it("returns the documented pagination, meta, and GameSummary shape", async () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, {
      name: "Portal 2",
      sizeOnDisk: 13200000000,
      lastPlayed: 1712100000,
    });
    steam.writeLocalConfig({ "620": { playtime: 612, playtime2wks: 45 } });
    const test = harness(steam);
    await post(test.app, "/api/refresh", { scope: "library" });

    const response = await get(test.app, "/api/games?pageSize=60");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: GameSummary[];
      pagination: Record<string, number>;
      meta: { dataAsOf: string | null };
    };
    expect(body.pagination).toEqual({ page: 1, pageSize: 60, totalItems: 1, totalPages: 1 });
    expect(body.meta.dataAsOf).toMatch(/Z$/);
    expect(body.data[0]).toMatchObject({
      appId: 620,
      name: "Portal 2",
      ownershipStatus: "local_only",
      installed: true,
      playtimeMinutes: 612,
      lastPlayedAt: "2024-04-02T23:20:00Z",
      tags: [],
      platforms: null,
      type: null,
      releaseYear: null,
      metacriticScore: null,
      reviewScore: null,
      reviewTier: null,
      reviewCount: null,
      metadata: { tagsStatus: "missing", storeStatus: "missing", reviewStatus: "missing" },
    });
    expect(body.data[0]).not.toHaveProperty("libraryPath");
    expect(body.data[0]).not.toHaveProperty("sourceMask");
  });

  it("searches names, filters installed, sorts with nulls last, and pages with appId ties", async () => {
    const test = harness();
    seedGame(test.db, 10, { name: "Alpha", installed: 1, playtime: 100, releaseYear: 2001 });
    seedGame(test.db, 20, { name: "Beta", installed: 0, playtime: 300, releaseYear: null });
    seedGame(test.db, 30, { name: "alphabet", installed: 1, playtime: 200, releaseYear: 1999 });
    seedGame(test.db, 40, { name: "Gamma", installed: null, playtime: 0, releaseYear: 2010 });
    seedGame(test.db, 50, { name: "Alpha Two", installed: 0, playtime: 200, releaseYear: null });

    const search = (await get(test.app, "/api/games?search=ALPHA")).json() as {
      data: GameSummary[];
    };
    expect(search.data.map((game) => game.appId)).toEqual([10, 50, 30]);

    const installed = (await get(test.app, "/api/games?installed=true")).json() as {
      data: GameSummary[];
    };
    expect(installed.data.map((game) => game.appId)).toEqual([10, 30]);

    const byPlaytime = (await get(test.app, "/api/games?sort=playtime&order=desc")).json() as {
      data: GameSummary[];
    };
    // 200 ties break by appId ASC; zero is the lowest, not last.
    expect(byPlaytime.data.map((game) => game.appId)).toEqual([20, 30, 50, 10, 40]);

    const byYear = (await get(test.app, "/api/games?sort=releaseYear&order=desc")).json() as {
      data: GameSummary[];
    };
    // Null release years sort last in either direction.
    expect(byYear.data.map((game) => game.appId)).toEqual([40, 10, 30, 20, 50]);

    const page = (await get(test.app, "/api/games?page=2&pageSize=2&sort=appId")).json() as {
      data: GameSummary[];
      pagination: Record<string, number>;
    };
    expect(page.pagination).toEqual({ page: 2, pageSize: 2, totalItems: 5, totalPages: 3 });
    expect(page.data.map((game) => game.appId)).toEqual([30, 40]);

    const lastPage = (await get(test.app, "/api/games?page=3&pageSize=2&sort=appId")).json() as {
      data: GameSummary[];
    };
    expect(lastPage.data.map((game) => game.appId)).toEqual([50]);
  });

  it("returns an empty list with totalPages 0 for a fresh database", async () => {
    const test = harness();
    const response = await get(test.app, "/api/games");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: GameSummary[];
      pagination: Record<string, number>;
      meta: { dataAsOf: string | null };
    };
    expect(body.data).toEqual([]);
    expect(body.pagination.totalItems).toBe(0);
    expect(body.pagination.totalPages).toBe(0);
    expect(body.meta.dataAsOf).toBeNull();
  });

  it("validates pageSize, sort, order, installed, and page", async () => {
    const test = harness();
    for (const [url, field] of [
      ["/api/games?pageSize=201", "pageSize"],
      ["/api/games?pageSize=0", "pageSize"],
      ["/api/games?page=0", "page"],
      ["/api/games?sort=unknown", "sort"],
      ["/api/games?order=sideways", "order"],
      ["/api/games?installed=maybe", "installed"],
    ] as const) {
      const response = await get(test.app, url);
      expect(response.statusCode, url).toBe(422);
      const body = response.json() as { error: { code: string; details: { fieldErrors: object } } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.fieldErrors).toHaveProperty(field);
    }
  });

  it("filters by every documented review status and rejects others", async () => {
    const test = harness();
    const statuses = ["ok", "unavailable", "stale", "error"] as const;
    for (const [index, status] of statuses.entries()) {
      const appId = 10 + index;
      seedGame(test.db, appId);
      test.db.raw
        .prepare(
          `INSERT INTO steam_review_summaries (app_id, review_status, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(appId, status, 1);
    }
    seedGame(test.db, 99);

    for (const [index, status] of statuses.entries()) {
      const response = await get(test.app, `/api/games?reviewStatus=${status}`);
      expect(response.statusCode, status).toBe(200);
      const body = response.json() as { data: GameSummary[]; pagination: { totalItems: number } };
      expect(
        body.data.map((game) => game.appId),
        status,
      ).toEqual([10 + index]);
      expect(body.pagination.totalItems, status).toBe(1);
    }

    const missing = await get(test.app, "/api/games?reviewStatus=missing");
    expect((missing.json() as { data: GameSummary[] }).data.map((game) => game.appId)).toEqual([
      99,
    ]);

    for (const value of ["rate_limited", "blocked", "unknown", ""]) {
      const response = await get(test.app, `/api/games?reviewStatus=${value}`);
      if (value === "") {
        expect(response.statusCode).toBe(200);
      } else {
        expect(response.statusCode, value).toBe(422);
        const body = response.json() as {
          error: { code: string; details: { fieldErrors: object } };
        };
        expect(body.error.code).toBe("VALIDATION_ERROR");
        expect(body.error.details.fieldErrors).toHaveProperty("reviewStatus");
      }
    }
  });

  it("distinguishes a known zero from an unknown review count", async () => {
    const test = harness();
    seedGame(test.db, 10, { name: "Zero Reviews" });
    seedGame(test.db, 20, { name: "Unknown Reviews" });
    test.db.raw
      .prepare(
        `INSERT INTO steam_review_summaries (
           app_id, review_positive, review_negative, review_total, review_tier,
           review_status, review_fetched_at, updated_at
         ) VALUES (10, 0, 0, 0, NULL, 'unavailable', 100, 100)`,
      )
      .run();
    test.db.raw
      .prepare(
        `INSERT INTO steam_review_summaries (
           app_id, review_status, review_fetched_at, updated_at
         ) VALUES (20, 'stale', 100, 100)`,
      )
      .run();

    const list = (await get(test.app, "/api/games?sort=appId")).json() as { data: GameSummary[] };
    expect(list.data[0]).toMatchObject({
      appId: 10,
      reviewScore: null,
      reviewTier: null,
      reviewCount: 0,
      metadata: { reviewStatus: "unavailable" },
    });
    expect(list.data[1]).toMatchObject({
      appId: 20,
      reviewScore: null,
      reviewTier: null,
      reviewCount: null,
      metadata: { reviewStatus: "stale" },
    });

    const zeroDetail = ((await get(test.app, "/api/games/10")).json() as { data: GameDetail }).data;
    expect(zeroDetail).toMatchObject({
      reviewScore: null,
      reviewTier: null,
      reviewCount: 0,
      metadata: { reviewStatus: "unavailable", reviewFetchedAt: "1970-01-01T00:01:40Z" },
    });
  });
});

describe("GET /api/games/{appId}", () => {
  it("returns the local GameDetail fields and 404 for an unknown Game", async () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, { name: "Portal 2", sizeOnDisk: 13200000000 });
    const test = harness(steam);
    await post(test.app, "/api/refresh", { scope: "library" });

    const response = await get(test.app, "/api/games/620");
    expect(response.statusCode).toBe(200);
    const detail = (response.json() as { data: GameDetail }).data;
    expect(detail).toMatchObject({
      appId: 620,
      name: "Portal 2",
      sizeOnDiskBytes: 13200000000,
      releaseDateRaw: null,
      developers: [],
      publishers: [],
      genres: [],
      categories: [],
      steamCollections: [],
      tags: [],
    });

    const missing = await get(test.app, "/api/games/999");
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");

    const invalid = await get(test.app, "/api/games/not-a-number");
    expect(invalid.statusCode).toBe(404);
  });

  it("exposes Tags with votes in summaries and the full list in detail", async () => {
    const test = harness();
    seedGame(test.db, 620, { name: "Portal 2" });
    test.db.raw
      .prepare("INSERT INTO tags (id, name, name_key) VALUES (1, 'Puzzle', 'puzzle')")
      .run();
    test.db.raw.prepare("INSERT INTO tags (id, name, name_key) VALUES (2, 'Co-op', 'co-op')").run();
    test.db.raw
      .prepare("INSERT INTO tags (id, name, name_key) VALUES (3, 'Action', 'action')")
      .run();
    test.db.raw.prepare("INSERT INTO tags (id, name, name_key) VALUES (4, 'Funny', 'funny')").run();
    test.db.raw
      .prepare("INSERT INTO game_tags (app_id, tag_id, votes) VALUES (620, 1, 31415)")
      .run();
    test.db.raw
      .prepare("INSERT INTO game_tags (app_id, tag_id, votes) VALUES (620, 2, 21000)")
      .run();
    test.db.raw
      .prepare("INSERT INTO game_tags (app_id, tag_id, votes) VALUES (620, 3, 9000)")
      .run();
    test.db.raw
      .prepare("INSERT INTO game_tags (app_id, tag_id, votes) VALUES (620, 4, 9000)")
      .run();

    const list = (await get(test.app, "/api/games")).json() as { data: GameSummary[] };
    expect(list.data[0]?.tags).toEqual([
      { name: "Puzzle", votes: 31415 },
      { name: "Co-op", votes: 21000 },
      { name: "Action", votes: 9000 },
    ]);

    const detail = ((await get(test.app, "/api/games/620")).json() as { data: GameDetail }).data;
    expect(detail.tags).toEqual([
      { name: "Puzzle", votes: 31415 },
      { name: "Co-op", votes: 21000 },
      { name: "Action", votes: 9000 },
      { name: "Funny", votes: 9000 },
    ]);
  });
});

describe("Steam Collection API", () => {
  async function collectionHarness() {
    const steam = fixture();
    steam.writeLocalConfig({});
    const filterSpec = { nFormatVersion: 2, filterGroups: [] };
    steam.writeCloudStorage([
      {
        key: "user-collections.favorite",
        value: JSON.stringify({ name: "Favorites", added: [620], removed: [] }),
      },
      {
        key: "user-collections.uc-beta",
        value: JSON.stringify({ name: "Beta", added: [10, 20], removed: [] }),
      },
      {
        key: "user-collections.uc-alpha",
        value: JSON.stringify({ name: "Alpha", added: [30], removed: [] }),
      },
      {
        key: "user-collections.uc-alpha2",
        value: JSON.stringify({ name: "Alpha", added: [620], removed: [] }),
      },
      {
        key: "user-collections.uc-dynamic",
        value: JSON.stringify({
          name: "Dynamic",
          added: [620],
          removed: [],
          filterSpec,
        }),
      },
      {
        key: "user-collections.uc-empty",
        value: JSON.stringify({ name: "Empty", added: [], removed: [] }),
      },
    ]);
    const test = harness(steam);
    await post(test.app, "/api/refresh", { scope: "library" });
    return test;
  }

  it("lists summaries ordered by name then id with documented pagination", async () => {
    const test = await collectionHarness();

    const response = await get(test.app, "/api/steam-collections?pageSize=2");
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: Array<{
        id: string;
        name: string;
        kind: string;
        isDynamic: boolean;
        gameCount: number | null;
      }>;
      pagination: Record<string, number>;
    };

    expect(body.pagination).toEqual({ page: 1, pageSize: 2, totalItems: 6, totalPages: 3 });
    expect(body.data).toEqual([
      { id: "uc-alpha", name: "Alpha", kind: "user", isDynamic: false, gameCount: 1 },
      { id: "uc-alpha2", name: "Alpha", kind: "user", isDynamic: false, gameCount: 1 },
    ]);

    const lastPage = (await get(test.app, "/api/steam-collections?page=3&pageSize=2")).json() as {
      data: Array<{ id: string; name: string }>;
      pagination: Record<string, number>;
    };
    expect(lastPage.pagination.totalPages).toBe(3);
    expect(lastPage.data.map((collection) => collection.id)).toEqual(["uc-empty", "favorite"]);

    const dynamic = (await get(test.app, "/api/steam-collections/uc-dynamic")).json() as {
      data: { gameCount: number | null; isDynamic: boolean };
    };
    expect(dynamic.data).toMatchObject({ gameCount: null, isDynamic: true });
  });

  it("returns one summary or 404 and never exposes the filterSpec or raw payload", async () => {
    const test = await collectionHarness();

    const response = await get(test.app, "/api/steam-collections/favorite");
    expect(response.statusCode).toBe(200);
    expect((response.json() as { data: unknown }).data).toEqual({
      id: "favorite",
      name: "Favorites",
      kind: "favorite",
      isDynamic: false,
      gameCount: 1,
    });
    expect(response.body).not.toContain("filter");
    expect(response.body).not.toContain("raw");

    const dynamic = await get(test.app, "/api/steam-collections/uc-dynamic");
    expect(dynamic.body).not.toContain("nFormatVersion");

    const missing = await get(test.app, "/api/steam-collections/uc-missing");
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("pages static members with sorting and reports meta.dynamic false", async () => {
    const test = await collectionHarness();

    const response = await get(
      test.app,
      "/api/steam-collections/uc-beta/games?page=2&pageSize=1&sort=appId&order=desc",
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: Array<{ appId: number }>;
      pagination: Record<string, number>;
      meta: { dataAsOf: string | null; dynamic: boolean };
    };
    expect(body.data.map((game) => game.appId)).toEqual([10]);
    expect(body.pagination).toEqual({ page: 2, pageSize: 1, totalItems: 2, totalPages: 2 });
    expect(body.meta.dynamic).toBe(false);
    expect(body.meta.dataAsOf).toMatch(/Z$/);
  });

  it("returns 200 [] for an empty static Collection and a dynamic Collection", async () => {
    const test = await collectionHarness();

    const empty = await get(test.app, "/api/steam-collections/uc-empty/games");
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({
      data: [],
      pagination: { page: 1, pageSize: 60, totalItems: 0, totalPages: 0 },
      meta: { dynamic: false },
    });

    const dynamic = await get(test.app, "/api/steam-collections/uc-dynamic/games");
    expect(dynamic.statusCode).toBe(200);
    expect(dynamic.json()).toMatchObject({
      data: [],
      pagination: { totalItems: 0 },
      meta: { dynamic: true },
    });

    const missing = await get(test.app, "/api/steam-collections/uc-missing/games");
    expect(missing.statusCode).toBe(404);
  });

  it("includes only static Collections in GameDetail", async () => {
    const test = await collectionHarness();

    const response = await get(test.app, "/api/games/620");
    const detail = (response.json() as { data: GameDetail }).data;

    expect(detail.steamCollections).toEqual([
      { id: "uc-alpha2", name: "Alpha", kind: "user" },
      { id: "favorite", name: "Favorites", kind: "favorite" },
    ]);
    expect(detail).not.toHaveProperty("filterSpec");
    expect(detail).not.toHaveProperty("rawValueJson");
  });

  it("validates page and pageSize", async () => {
    const test = await collectionHarness();

    for (const [url, field] of [
      ["/api/steam-collections?pageSize=201", "pageSize"],
      ["/api/steam-collections?page=0", "page"],
      ["/api/steam-collections/favorite/games?pageSize=0", "pageSize"],
      ["/api/steam-collections/favorite/games?sort=nope", "sort"],
      ["/api/steam-collections/favorite/games?order=sideways", "order"],
    ] as const) {
      const response = await get(test.app, url);
      expect(response.statusCode, url).toBe(422);
      const body = response.json() as {
        error: { code: string; details: { fieldErrors: Record<string, string> } };
      };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.fieldErrors).toHaveProperty(field);
    }
  });
});

describe("GET /api/status with a Library", () => {
  it("reports counts, last scan, source health, and the last Refresh run", async () => {
    const steam = fixture();
    steam.writeManifest(steam.root, 620, { name: "Portal 2" });
    steam.writeManifest(steam.root, 730, { name: "CS:GO", stateFlags: 1026 });
    steam.writeLocalConfig({});
    const test = harness(steam);
    const run = (await post(test.app, "/api/refresh", { scope: "library" })).json() as {
      data: RefreshRun;
    };

    const response = await get(test.app, "/api/status");
    const status = (response.json() as { data: Status }).data;

    expect(status.library).toMatchObject({
      gameCount: 2,
      installedCount: 1,
      lastScanStatus: "ok",
    });
    expect(status.library.lastScanAt).toMatch(/Z$/);
    expect(status.sources).toHaveLength(5);
    expect(status.sources[0]).toMatchObject({
      name: "steam_local",
      status: "ok",
      lastError: null,
    });
    expect(status.sources[0]?.lastSuccessAt).toMatch(/Z$/);
    expect(status.lastRefresh?.id).toBe(run.data.id);
    expect(status.activeRefresh).toBeNull();
  });

  it("reports partial after an unreadable library", async () => {
    const steam = fixture();
    const second = steam.addLibrary("SecondLibrary");
    steam.writeManifest(second, 730);
    rmSync(second, { recursive: true, force: true });
    const test = harness(steam);

    const started = (await post(test.app, "/api/refresh", { scope: "library" })).json() as {
      data: RefreshRun;
    };
    const run = (await get(test.app, `/api/refresh/${started.data.id}`)).json() as {
      data: RefreshRun;
    };
    expect(run.data.status).toBe("partial");

    const status = (await get(test.app, "/api/status")).json() as { data: Status };
    expect(status.data.library.lastScanStatus).toBe("partial");
    expect(status.data.sources[0]?.status).toBe("partial");
  });
});

describe("GET /api/games?storeStatus=", () => {
  it("accepts exactly the documented values and returns only matching Games", async () => {
    const test = harness();
    const statuses = ["ok", "unavailable", "missing", "stale", "error"] as const;
    const appIds = [620, 621, 622, 623, 624];
    for (const [index, appId] of appIds.entries()) {
      seedGame(test.db, appId);
      test.db.raw
        .prepare(
          `INSERT INTO storefront_appdetails (app_id, store_status, updated_at)
           VALUES (?, ?, 1)`,
        )
        .run(appId, statuses[index]!);
    }
    // A Game with no storefront row reads as `missing`.
    seedGame(test.db, 625);

    for (const status of statuses) {
      const response = await get(test.app, `/api/games?storeStatus=${status}`);
      expect(response.statusCode, status).toBe(200);
      const body = response.json() as { data: GameSummary[]; pagination: { totalItems: number } };
      const expected = status === "missing" ? [622, 625] : [appIds[statuses.indexOf(status)]!];
      expect(
        body.data.map((game) => game.appId),
        status,
      ).toEqual(expected);
      expect(body.pagination.totalItems).toBe(expected.length);
      for (const game of body.data) {
        expect(game.metadata.storeStatus).toBe(status);
      }
    }

    for (const invalid of ["unknown", "partial", "blocked", "OK", ""]) {
      const response = await get(test.app, `/api/games?storeStatus=${invalid}`);
      if (invalid === "") {
        expect(response.statusCode).toBe(200);
        continue;
      }
      expect(response.statusCode, invalid).toBe(422);
      expect(response.json()).toMatchObject({
        error: {
          code: "VALIDATION_ERROR",
          details: { fieldErrors: { storeStatus: expect.any(String) } },
        },
      });
    }
  });
});

describe("GET /api/tags", () => {
  function seedTag(db: AppDatabase, id: number, name: string): void {
    db.raw
      .prepare("INSERT INTO tags (id, name, name_key) VALUES (?, ?, ?)")
      .run(id, name, name.toLowerCase());
  }

  function tagGame(db: AppDatabase, appId: number, tagId: number, votes = 1): void {
    db.raw
      .prepare("INSERT INTO game_tags (app_id, tag_id, votes) VALUES (?, ?, ?)")
      .run(appId, tagId, votes);
  }

  function seedTagLibrary(): Harness {
    const test = harness();
    for (const appId of [1, 2, 3]) {
      seedGame(test.db, appId);
    }
    seedTag(test.db, 1, "Puzzle");
    seedTag(test.db, 2, "Action");
    seedTag(test.db, 3, "Roguelike");
    seedTag(test.db, 4, "Orphan");
    tagGame(test.db, 1, 1);
    tagGame(test.db, 2, 1);
    tagGame(test.db, 1, 2);
    tagGame(test.db, 3, 3);
    return test;
  }

  it("returns distinct-Game counts ordered by count, name key, then id", async () => {
    const test = seedTagLibrary();
    const response = await get(test.app, "/api/tags");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        { name: "Puzzle", gameCount: 2 },
        { name: "Action", gameCount: 1 },
        { name: "Roguelike", gameCount: 1 },
      ],
      pagination: { page: 1, pageSize: 20, totalItems: 3, totalPages: 1 },
    });
  });

  it("matches the normalized query case-insensitively and excludes Tags with no Games", async () => {
    const test = seedTagLibrary();
    const response = await get(test.app, "/api/tags?query=PUZ");
    expect((response.json() as { data: Array<{ name: string; gameCount: number }> }).data).toEqual([
      { name: "Puzzle", gameCount: 2 },
    ]);

    const orphan = await get(test.app, "/api/tags?query=orphan");
    expect((orphan.json() as { data: unknown[] }).data).toEqual([]);
    expect((orphan.json() as { pagination: { totalItems: number } }).pagination.totalItems).toBe(0);
  });

  it("pages by Tags, not Games", async () => {
    const test = seedTagLibrary();
    const first = (await get(test.app, "/api/tags?pageSize=2")).json() as {
      data: Array<{ name: string }>;
      pagination: Record<string, number>;
    };
    expect(first.data.map((tag) => tag.name)).toEqual(["Puzzle", "Action"]);
    expect(first.pagination).toEqual({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });

    const second = (await get(test.app, "/api/tags?pageSize=2&page=2")).json() as {
      data: Array<{ name: string }>;
    };
    expect(second.data.map((tag) => tag.name)).toEqual(["Roguelike"]);
  });

  it("returns an empty list for a fresh database", async () => {
    const test = harness();
    expect((await get(test.app, "/api/tags")).json()).toEqual({
      data: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    });
  });

  it("validates query length, page, and pageSize", async () => {
    const test = harness();
    for (const [url, field] of [
      [`/api/tags?query=${"x".repeat(81)}`, "query"],
      ["/api/tags?page=0", "page"],
      ["/api/tags?pageSize=0", "pageSize"],
      ["/api/tags?pageSize=101", "pageSize"],
    ] as const) {
      const response = await get(test.app, url);
      expect(response.statusCode, url).toBe(422);
      const body = response.json() as { error: { code: string; details: { fieldErrors: object } } };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.fieldErrors).toHaveProperty(field);
    }
  });
});

describe("GET /api/games?tagsStatus", () => {
  function seedStatuses(): Harness {
    const test = harness();
    for (const appId of [1, 2, 3, 4, 5]) {
      seedGame(test.db, appId);
    }
    const insert = test.db.raw.prepare(
      `INSERT INTO steamspy_appdetails (app_id, tags_status, tags_fetched_at, updated_at)
       VALUES (?, ?, ?, 1)`,
    );
    insert.run(1, "ok", 10);
    insert.run(2, "missing", 10);
    insert.run(3, "stale", 10);
    insert.run(4, "error", null);
    // Game 5 has no row and reads as missing with no fetch timestamp.
    return test;
  }

  it("returns only Games with the requested tags status", async () => {
    const test = seedStatuses();
    for (const [status, expected] of [
      ["ok", [1]],
      ["missing", [2, 5]],
      ["stale", [3]],
      ["error", [4]],
    ] as const) {
      const response = await get(test.app, `/api/games?tagsStatus=${status}&sort=appId`);
      expect(response.statusCode, status).toBe(200);
      expect(
        (response.json() as { data: GameSummary[] }).data.map((game) => game.appId),
        status,
      ).toEqual(expected);
    }
  });

  it("rejects unsupported tags status values", async () => {
    const test = harness();
    for (const status of ["unavailable", "unknown", "OK"]) {
      const response = await get(test.app, `/api/games?tagsStatus=${status}`);
      expect(response.statusCode, status).toBe(422);
      const body = response.json() as {
        error: { code: string; details: { fieldErrors: Record<string, string> } };
      };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.fieldErrors).toHaveProperty("tagsStatus");
    }
  });
});
