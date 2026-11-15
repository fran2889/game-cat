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
import type { SteamOwnershipSource } from "../../src/server/steam/ownership.ts";
import type { SteamDiscovery } from "../../src/server/steam/discovery.ts";
import type { OwnershipFetchResult } from "../../src/server/steam/ownership.ts";
import type { RefreshRun, Status } from "../../src/shared/types.ts";
import { TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

const NOW = 1_700_000_000;
const OTHER_STEAM_ID64 = "76561198000000001";
const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;

const dataDirs: string[] = [];
const databases: AppDatabase[] = [];
const apps: Array<ReturnType<typeof createHttpApp>> = [];

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (dataDirs.length > 0) {
    rmSync(dataDirs.pop()!, { recursive: true, force: true });
  }
});

const discovery: SteamDiscovery = {
  root: "/fixture/Steam",
  state: "ready",
  accounts: [{ steamId64: TEST_STEAM_ID64, accountId: "39734272", personaName: "Player One" }],
  account: {
    steamId64: TEST_STEAM_ID64,
    accountId: "39734272",
    personaName: "Player One",
  },
  ambiguous: false,
  error: null,
};

function database(configured = true): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-ownership-db-"));
  dataDirs.push(dir);
  const db = openAppDatabase({ dataDir: dir, steamWebApiConfigured: configured });
  databases.push(db);
  return db;
}

function sourceOf(result: OwnershipFetchResult): SteamOwnershipSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetchOwnedGames(steamId64: string) {
      calls.push(steamId64);
      return result;
    },
  };
}

interface Harness {
  db: AppDatabase;
  refresh: RefreshService;
  source: SteamOwnershipSource & { calls: string[] };
  app: ReturnType<typeof createHttpApp>;
}

function harness(
  result: OwnershipFetchResult,
  options: {
    db?: AppDatabase;
    steamId64?: string | null;
    steamApiKey?: string | null;
  } = {},
): Harness {
  const db = options.db ?? database(options.steamApiKey !== null);
  const source = sourceOf(result);
  const steamId64 = options.steamId64 === undefined ? TEST_STEAM_ID64 : options.steamId64;
  const steamApiKey = options.steamApiKey === undefined ? "SECRET_KEY" : options.steamApiKey;
  const refresh = new RefreshService({
    db: db.raw,
    steamRoot: null,
    steamId64,
    steamApiKey,
    ownershipSource: source,
    now: () => NOW,
  });
  const app = createHttpApp({
    port: PORT,
    clientDir: null,
    logger: pino({ level: "silent" }),
    status: () =>
      buildStatus({
        discovery,
        steamApiKey,
        configuredSteamId64: steamId64,
        schemaVersion: db.schemaVersion,
        db: db.raw,
      }),
    library: {
      games: new GamesRepository(db.raw),
      collections: new SteamCollectionsRepository(db.raw),
      ruleValues: new RuleValuesRepository(db.raw),
      rulePreview: new RulePreviewRepository(db.raw),
      smartCollections: new SmartCollectionsRepository(db.raw),
      tags: new TagsRepository(db.raw),
      refresh,
    },
  });
  apps.push(app);
  return { db, refresh, source, app };
}

interface SeedOptions {
  name?: string;
  nameSource?: string;
  ownership?: string;
  installed?: number | null;
  localPlaytime?: number | null;
  localRecent?: number | null;
  apiPlaytime?: number | null;
  apiRecent?: number | null;
  sourceMask?: number;
  localconfigLastPlayed?: number | null;
}

function seedGame(db: AppDatabase, appId: number, options: SeedOptions = {}): void {
  const name = options.name ?? `Game ${appId}`;
  const local = options.localPlaytime ?? null;
  const api = options.apiPlaytime ?? null;
  db.raw
    .prepare(
      `INSERT INTO games (
         app_id, name, name_key, name_source, ownership_status, installed,
         local_playtime_minutes, local_playtime_2weeks_minutes,
         api_playtime_minutes, api_playtime_2weeks_minutes,
         playtime_minutes, playtime_2weeks_minutes,
         localconfig_last_played_at, source_mask, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    )
    .run(
      appId,
      name,
      name.toLowerCase(),
      options.nameSource ?? "placeholder",
      options.ownership ?? "owned",
      options.installed === undefined ? null : options.installed,
      local,
      options.localRecent ?? null,
      api,
      options.apiRecent ?? null,
      local ?? api ?? 0,
      options.localRecent ?? options.apiRecent ?? null,
      options.localconfigLastPlayed ?? null,
      options.sourceMask ?? 1,
    );
}

function gameRow(db: AppDatabase, appId: number): Record<string, unknown> | undefined {
  return db.raw.prepare("SELECT * FROM games WHERE app_id = ?").get(appId) as
    Record<string, unknown> | undefined;
}

function sourceRow(db: AppDatabase): Record<string, unknown> {
  return db.raw.prepare("SELECT * FROM source_state WHERE name = 'steam_web_api'").get() as Record<
    string,
    unknown
  >;
}

async function runOwnership(harnessValue: Harness): Promise<RefreshRun> {
  const started = await harnessValue.refresh.start({ scope: "ownership" });
  await harnessValue.refresh.waitForIdle();
  return harnessValue.refresh.get(Number(started.run.id))!;
}

describe("ownership refresh: complete response", () => {
  it("upserts owned Games, fills API playtime, preserves local precedence, and binds the Account", async () => {
    const test = harness({
      kind: "complete",
      gameCount: 2,
      games: [
        {
          appId: 620,
          name: "Portal 2",
          playtimeForeverMinutes: 100,
          playtime2WeeksMinutes: 7,
        },
        { appId: 570, name: "Dota 2", playtimeForeverMinutes: 50, playtime2WeeksMinutes: null },
      ],
    });
    seedGame(test.db, 620, {
      name: "Portal 2 (local)",
      nameSource: "local",
      ownership: "local_only",
      installed: 1,
      localPlaytime: 612,
      localRecent: 45,
      sourceMask: 6,
    });

    const run = await runOwnership(test);

    expect(run).toMatchObject({
      scope: "ownership",
      mode: null,
      status: "succeeded",
      total: 2,
      done: 2,
      appIds: null,
      stats: null,
      error: null,
    });
    expect(gameRow(test.db, 620)).toMatchObject({
      name: "Portal 2",
      name_key: "portal 2",
      name_source: "steam_web_api",
      ownership_status: "owned",
      installed: 1,
      local_playtime_minutes: 612,
      local_playtime_2weeks_minutes: 45,
      api_playtime_minutes: 100,
      api_playtime_2weeks_minutes: 7,
      playtime_minutes: 612,
      playtime_2weeks_minutes: 45,
      source_mask: 7,
      last_seen_at: NOW,
    });
    expect(gameRow(test.db, 570)).toMatchObject({
      name: "Dota 2",
      name_source: "steam_web_api",
      ownership_status: "owned",
      installed: null,
      local_playtime_minutes: null,
      api_playtime_minutes: 50,
      api_playtime_2weeks_minutes: null,
      playtime_minutes: 50,
      playtime_2weeks_minutes: null,
      source_mask: 1,
    });
    expect(test.db.raw.prepare("SELECT steam_id64 FROM account_state").get()).toEqual({
      steam_id64: TEST_STEAM_ID64,
    });
    expect(sourceRow(test.db)).toMatchObject({
      status: "ok",
      last_attempt_at: NOW,
      last_success_at: NOW,
      retry_after_at: null,
      last_error: null,
    });
    const row = test.db.raw.prepare("SELECT * FROM refresh_runs WHERE id = ?").get(run.id) as {
      scope: string;
      mode: string | null;
      status: string;
      steam_id64: string;
    };
    expect(row).toMatchObject({
      scope: "ownership",
      mode: null,
      status: "succeeded",
      steam_id64: TEST_STEAM_ID64,
    });

    const fetched = await test.app.inject({
      method: "GET",
      url: `/api/refresh/${run.id}`,
      headers: { host: HOST },
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as { data: RefreshRun }).data).toEqual(run);
  });

  it("reconciles absent rows: local evidence becomes local_only, non-local owned rows cascade", async () => {
    const test = harness({
      kind: "complete",
      gameCount: 1,
      games: [
        { appId: 620, name: "Portal 2", playtimeForeverMinutes: 1, playtime2WeeksMinutes: null },
      ],
    });
    const db = test.db.raw;
    seedGame(test.db, 620);
    seedGame(test.db, 730, {
      ownership: "owned",
      installed: 0,
      localPlaytime: 30,
      sourceMask: 5,
    });
    seedGame(test.db, 999, { ownership: "owned", sourceMask: 1 });
    db.prepare(
      `INSERT INTO storefront_appdetails (app_id, type, updated_at) VALUES (999, 'game', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO steam_review_summaries (app_id, review_status, updated_at)
       VALUES (999, 'missing', 1)`,
    ).run();

    await runOwnership(test);

    expect(gameRow(test.db, 620)).toMatchObject({
      ownership_status: "owned",
      source_mask: 1,
    });
    expect(gameRow(test.db, 730)).toMatchObject({
      ownership_status: "local_only",
      source_mask: 4,
    });
    expect(gameRow(test.db, 999)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM storefront_appdetails").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM steam_review_summaries").get()).toEqual({
      count: 0,
    });
  });

  it("applies the §2.7 name matrix and recomputes name_key", async () => {
    const games = [
      { appId: 1, name: "API One", playtimeForeverMinutes: 0, playtime2WeeksMinutes: null },
      { appId: 2, name: "API Two", playtimeForeverMinutes: 0, playtime2WeeksMinutes: null },
      { appId: 3, name: "API Three", playtimeForeverMinutes: 0, playtime2WeeksMinutes: null },
      { appId: 4, name: "API Four", playtimeForeverMinutes: 0, playtime2WeeksMinutes: null },
      { appId: 5, name: null, playtimeForeverMinutes: 0, playtime2WeeksMinutes: null },
    ];
    const test = harness({ kind: "complete", gameCount: games.length, games });
    seedGame(test.db, 1, { name: "Store Name", nameSource: "storefront" });
    seedGame(test.db, 2, { name: "Old API", nameSource: "steam_web_api" });
    seedGame(test.db, 3, { name: "Local Name", nameSource: "local" });
    seedGame(test.db, 4, { name: "SteamSpy Name", nameSource: "steamspy" });
    seedGame(test.db, 5, { name: "Placeholder", nameSource: "placeholder" });

    await runOwnership(test);

    expect(gameRow(test.db, 1)).toMatchObject({
      name: "Store Name",
      name_source: "storefront",
    });
    expect(gameRow(test.db, 2)).toMatchObject({
      name: "API Two",
      name_key: "api two",
      name_source: "steam_web_api",
    });
    expect(gameRow(test.db, 3)).toMatchObject({ name: "API Three", name_source: "steam_web_api" });
    expect(gameRow(test.db, 4)).toMatchObject({ name: "API Four", name_source: "steam_web_api" });
    expect(gameRow(test.db, 5)).toMatchObject({
      name: "Placeholder",
      name_source: "placeholder",
    });
  });

  it("turns Collection-only unknown rows into local_only after a conclusive response", async () => {
    const test = harness({
      kind: "complete",
      gameCount: 1,
      games: [
        { appId: 620, name: "Portal 2", playtimeForeverMinutes: 0, playtime2WeeksMinutes: null },
      ],
    });
    seedGame(test.db, 777, { ownership: "unknown", sourceMask: 8 });

    await runOwnership(test);

    expect(gameRow(test.db, 777)).toMatchObject({
      ownership_status: "local_only",
      source_mask: 8,
    });
  });
});

describe("ownership refresh: inconclusive responses", () => {
  it("AC-L4 leaves every row intact for an empty response and records empty", async () => {
    const test = harness({ kind: "empty", gameCount: 0, games: [] });
    seedGame(test.db, 620, { localPlaytime: 1, sourceMask: 5 });
    seedGame(test.db, 999);

    const run = await runOwnership(test);

    expect(run.status).toBe("succeeded");
    expect(gameRow(test.db, 620)).toMatchObject({
      ownership_status: "owned",
      source_mask: 5,
      last_seen_at: 1,
    });
    expect(gameRow(test.db, 999)).toMatchObject({ ownership_status: "owned", source_mask: 1 });
    expect(sourceRow(test.db)).toMatchObject({ status: "empty", last_success_at: NOW });
    // A successful account-scoped run binds the Account even when nothing in
    // the roster changed.
    expect(test.db.raw.prepare("SELECT steam_id64 FROM account_state").get()).toEqual({
      steam_id64: TEST_STEAM_ID64,
    });
  });

  it("AC-L4 upserts a short response without reconciling absent rows and records partial", async () => {
    const test = harness({
      kind: "partial",
      gameCount: 3,
      games: [
        { appId: 620, name: "Portal 2", playtimeForeverMinutes: 1, playtime2WeeksMinutes: null },
      ],
    });
    seedGame(test.db, 999);

    const run = await runOwnership(test);

    expect(run.status).toBe("partial");
    expect(gameRow(test.db, 620)).toMatchObject({ ownership_status: "owned", source_mask: 1 });
    expect(gameRow(test.db, 999)).toMatchObject({ ownership_status: "owned", source_mask: 1 });
    expect(sourceRow(test.db)).toMatchObject({ status: "partial" });
  });
});

describe("ownership refresh: upstream failures keep the cached roster", () => {
  const failures: Array<{
    name: string;
    result: OwnershipFetchResult;
    expectedState: string;
    expectedRetryAt?: number | null;
  }> = [
    {
      name: "invalid key",
      result: { kind: "invalid_key", message: "Steam rejected the key." },
      expectedState: "invalid_key",
    },
    {
      name: "rate limited",
      result: {
        kind: "rate_limited",
        retryAfterAt: NOW + 120,
        message: "Slow down.",
      },
      expectedState: "rate_limited",
      expectedRetryAt: NOW + 120,
    },
    {
      name: "server error",
      result: { kind: "error", message: "The Steam Web API failed with status 503." },
      expectedState: "error",
    },
  ];

  for (const failure of failures) {
    it(`records ${failure.name} and writes nothing`, async () => {
      const test = harness(failure.result);
      seedGame(test.db, 620, {
        name: "Portal 2",
        localPlaytime: 10,
        apiPlaytime: 20,
        ownership: "owned",
        sourceMask: 5,
      });
      test.db.raw
        .prepare(
          "UPDATE source_state SET status = 'ok', last_success_at = 50 WHERE name = 'steam_web_api'",
        )
        .run();

      const run = await runOwnership(test);

      expect(run.status).toBe("partial");
      expect(run.error?.code).toBeDefined();
      expect(gameRow(test.db, 620)).toMatchObject({
        name: "Portal 2",
        ownership_status: "owned",
        api_playtime_minutes: 20,
        source_mask: 5,
        last_seen_at: 1,
      });
      expect(sourceRow(test.db)).toMatchObject({
        status: failure.expectedState,
        last_attempt_at: NOW,
        last_success_at: 50,
        retry_after_at: failure.expectedRetryAt ?? null,
      });
      expect(sourceRow(test.db).last_error).toEqual(expect.any(String));
      expect(test.db.raw.prepare("SELECT COUNT(*) AS count FROM account_state").get()).toEqual({
        count: 0,
      });
    });
  }
});

describe("ownership refresh: Account binding", () => {
  it("AC-L10 fails with ACCOUNT_MISMATCH and writes or deletes nothing", async () => {
    const db = database();
    db.raw
      .prepare("INSERT INTO account_state (singleton, steam_id64, bound_at) VALUES (1, ?, 1)")
      .run(OTHER_STEAM_ID64);
    const test = harness(
      {
        kind: "complete",
        gameCount: 1,
        games: [
          { appId: 620, name: "Portal 2", playtimeForeverMinutes: 1, playtime2WeeksMinutes: null },
        ],
      },
      { db },
    );
    seedGame(test.db, 620, { name: "Cached", apiPlaytime: 3, sourceMask: 5 });
    const before = gameRow(test.db, 620);
    const sourceBefore = sourceRow(test.db);

    const run = await runOwnership(test);

    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "ACCOUNT_MISMATCH" });
    expect(test.source.calls).toEqual([]);
    expect(gameRow(test.db, 620)).toEqual(before);
    expect(sourceRow(test.db)).toEqual(sourceBefore);
    expect(test.db.raw.prepare("SELECT steam_id64 FROM account_state").get()).toEqual({
      steam_id64: OTHER_STEAM_ID64,
    });
  });

  it("does not bind for a metadata-only run", async () => {
    const test = harness({ kind: "empty", gameCount: 0, games: [] });
    const response = await test.app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { host: HOST },
      payload: { scope: "metadata", mode: "fetch" },
    });

    expect(response.statusCode).toBe(202);
    await test.refresh.waitForIdle();
    expect(test.db.raw.prepare("SELECT COUNT(*) AS count FROM account_state").get()).toEqual({
      count: 0,
    });
    expect(test.db.raw.prepare("SELECT COUNT(*) AS count FROM refresh_runs").get()).toEqual({
      count: 1,
    });
  });
});

describe("POST /api/refresh ownership configuration", () => {
  it("returns 409 OWNERSHIP_NOT_CONFIGURED with the missing inputs", async () => {
    const missingKey = harness({ kind: "empty", gameCount: 0, games: [] }, { steamApiKey: null });
    const keyResponse = await missingKey.app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { host: HOST },
      payload: { scope: "ownership" },
    });
    expect(keyResponse.statusCode).toBe(409);
    expect(
      (keyResponse.json() as { error: { code: string; details: { missing: string[] } } }).error,
    ).toMatchObject({ code: "OWNERSHIP_NOT_CONFIGURED", details: { missing: ["webApiKey"] } });

    const missingAccount = harness({ kind: "empty", gameCount: 0, games: [] }, { steamId64: null });
    const accountResponse = await missingAccount.app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { host: HOST },
      payload: { scope: "ownership" },
    });
    expect(accountResponse.statusCode).toBe(409);
    expect(
      (accountResponse.json() as { error: { details: { missing: string[] } } }).error.details,
    ).toEqual({ missing: ["steamId64"] });
  });

  it("still accepts the library scope and rejects modes on ownership", async () => {
    const test = harness({ kind: "empty", gameCount: 0, games: [] });
    const withMode = await test.app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { host: HOST },
      payload: { scope: "ownership", mode: "fetch" },
    });
    expect(withMode.statusCode).toBe(422);

    const library = await test.app.inject({
      method: "POST",
      url: "/api/refresh",
      headers: { host: HOST },
      payload: { scope: "library" },
    });
    expect(library.statusCode).toBe(202);
  });
});

describe("GET /api/status ownership surface", () => {
  it("reports ownership state, owned count, counts, timestamps, and source health", async () => {
    const test = harness({
      kind: "complete",
      gameCount: 1,
      games: [
        { appId: 620, name: "Portal 2", playtimeForeverMinutes: 0, playtime2WeeksMinutes: null },
      ],
    });
    seedGame(test.db, 730, { ownership: "local_only", sourceMask: 5 });
    seedGame(test.db, 740, { ownership: "unknown", sourceMask: 8 });

    const before = buildStatus({
      discovery,
      steamApiKey: "SECRET_KEY",
      configuredSteamId64: TEST_STEAM_ID64,
      schemaVersion: test.db.schemaVersion,
      db: test.db.raw,
    });
    expect(before.ownership.counts).toEqual({ owned: 0, localOnly: 1, unknown: 1 });

    await runOwnership(test);
    const response = await test.app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: HOST },
    });
    const status = (response.json() as { data: Status }).data;

    expect(status.ownership).toMatchObject({
      state: "ok",
      gameCount: 1,
      // The conclusive response demoted the Collection-only row to local_only.
      counts: { owned: 1, localOnly: 2, unknown: 0 },
      lastSuccessAt: new Date(NOW * 1000).toISOString().replace(".000Z", "Z"),
      lastAttemptAt: new Date(NOW * 1000).toISOString().replace(".000Z", "Z"),
      error: null,
    });
    expect(status.sources.find((source) => source.name === "steam_web_api")).toMatchObject({
      status: "ok",
      lastSuccessAt: status.ownership.lastSuccessAt,
      lastAttemptAt: status.ownership.lastAttemptAt,
    });
  });

  it("reports invalid_key and the persisted ErrorDetail without overwriting a later state", async () => {
    const test = harness({ kind: "invalid_key", message: "Steam rejected the key." });
    await runOwnership(test);

    const withKey = buildStatus({
      discovery,
      steamApiKey: "SECRET_KEY",
      configuredSteamId64: TEST_STEAM_ID64,
      schemaVersion: test.db.schemaVersion,
      db: test.db.raw,
    });
    expect(withKey.ownership.state).toBe("invalid_key");
    expect(withKey.ownership.error).toMatchObject({ code: "INVALID_KEY" });

    const withoutKey = buildStatus({
      discovery,
      steamApiKey: null,
      configuredSteamId64: TEST_STEAM_ID64,
      schemaVersion: test.db.schemaVersion,
      db: test.db.raw,
    });
    expect(withoutKey.ownership.state).toBe("invalid_key");
    expect(withoutKey.sources.find((source) => source.name === "steam_web_api")?.status).toBe(
      "invalid_key",
    );
  });
});
