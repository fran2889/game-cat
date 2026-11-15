import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../../src/server/db/database.ts";
import { createHttpApp } from "../../src/server/http/app.ts";
import { SteamCollectionsRepository } from "../../src/server/library/collections.ts";
import { GamesRepository } from "../../src/server/library/games.ts";
import { RulePreviewRepository } from "../../src/server/library/rule-preview.ts";
import { SmartCollectionsRepository } from "../../src/server/library/smart-collections.ts";
import { RuleValuesRepository } from "../../src/server/library/rule-values.ts";
import { TagsRepository } from "../../src/server/library/tags.ts";
import type { LibraryScanResult, scanLocalLibrary } from "../../src/server/library/scan.ts";
import { RefreshService } from "../../src/server/refresh/service.ts";
import type {
  MetadataSource,
  MetadataSourceContext,
  MetadataSourceName,
  MetadataSourceOutcome,
} from "../../src/server/refresh/sources.ts";
import { createServer, type RunningServer } from "../../src/server/index.ts";
import { buildStatus } from "../../src/server/status.ts";
import type { SteamDiscovery } from "../../src/server/steam/discovery.ts";
import type {
  OwnershipFetchResult,
  SteamOwnershipSource,
} from "../../src/server/steam/ownership.ts";
import type { RefreshRun, Status } from "../../src/shared/types.ts";
import { TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

const PORT = 4780;
const HOST = `127.0.0.1:${PORT}`;
const NOW = 1_700_000_000;

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

const dataDirs: string[] = [];
const databases: AppDatabase[] = [];
const apps: Array<ReturnType<typeof createHttpApp>> = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
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

class FakeClock {
  seconds = NOW;
  readonly sleeps: number[] = [];

  now = (): number => this.seconds;

  nowMs = (): number => this.seconds * 1_000;

  sleep = async (milliseconds: number): Promise<void> => {
    this.sleeps.push(milliseconds);
    this.seconds += milliseconds / 1_000;
  };
}

type Responder = (
  context: MetadataSourceContext,
  index: number,
) => MetadataSourceOutcome | Promise<MetadataSourceOutcome>;

class FakeSource implements MetadataSource {
  readonly calls: number[] = [];
  readonly times: number[] = [];
  readonly started: string[] = [];
  readonly finished: string[] = [];

  constructor(
    readonly name: MetadataSourceName,
    private readonly responder: Responder = () => ({ kind: "ok" }),
    readonly hostKey?: string,
  ) {}

  async fetch(context: MetadataSourceContext): Promise<MetadataSourceOutcome> {
    this.calls.push(context.game.appId);
    this.times.push(context.now);
    this.started.push(`${this.name}:start:${context.game.appId}`);
    const outcome = await this.responder(context, this.calls.length - 1);
    this.finished.push(`${this.name}:end:${context.game.appId}`);
    return outcome;
  }
}

class Deferred {
  released = false;
  private resolvePromise!: () => void;
  readonly promise = new Promise<void>((resolve) => {
    this.resolvePromise = resolve;
  });

  release(): void {
    if (!this.released) {
      this.released = true;
      this.resolvePromise();
    }
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

interface HarnessOptions {
  sources?: MetadataSource[];
  scan?: typeof scanLocalLibrary;
  steamApiKey?: string | null;
  steamId64?: string | null;
  ownershipSource?: SteamOwnershipSource;
  jitter?: number;
  clock?: FakeClock;
}

interface Harness {
  db: AppDatabase;
  refresh: RefreshService;
  app: ReturnType<typeof createHttpApp>;
  clock: FakeClock;
}

function harness(options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-refresh-"));
  dataDirs.push(dir);
  const steamId64 = options.steamId64 === undefined ? TEST_STEAM_ID64 : options.steamId64;
  const steamApiKey = options.steamApiKey === undefined ? "SECRET_KEY" : options.steamApiKey;
  const db = openAppDatabase({
    dataDir: dir,
    steamWebApiConfigured: steamApiKey !== null && steamId64 !== null,
    selectedSteamId64: steamId64,
  });
  databases.push(db);
  const clock = options.clock ?? new FakeClock();
  const refresh = new RefreshService({
    db: db.raw,
    steamRoot: null,
    steamId64,
    steamApiKey,
    now: clock.now,
    nowMs: clock.nowMs,
    jitter: () => options.jitter ?? 0,
    sleep: clock.sleep,
    sources: options.sources ?? [],
    ...(options.scan === undefined ? {} : { scan: options.scan }),
    ...(options.ownershipSource === undefined ? {} : { ownershipSource: options.ownershipSource }),
    onWarn: () => {},
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
  return { db, refresh, app, clock };
}

async function post(app: Harness["app"], payload: object): Promise<LightMyRequestResponse> {
  return app.inject({ method: "POST", url: "/api/refresh", headers: { host: HOST }, payload });
}

async function get(app: Harness["app"], url: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: "GET", url, headers: { host: HOST } });
}

async function startAndWait(
  test: Harness,
  payload: object,
): Promise<{ response: LightMyRequestResponse; run: RefreshRun }> {
  const response = await post(test.app, payload);
  expect(response.statusCode).toBe(202);
  const started = response.json() as { data: RefreshRun };
  await test.refresh.waitForIdle();
  const run = (await get(test.app, `/api/refresh/${started.data.id}`)).json() as {
    data: RefreshRun;
  };
  return { response, run: run.data };
}

function seedGame(db: AppDatabase, appId: number): void {
  db.raw
    .prepare(
      `INSERT INTO games (
         app_id, name, name_key, name_source, ownership_status,
         playtime_minutes, source_mask, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, 'placeholder', 'owned', 0, 1, 1, 1)`,
    )
    .run(appId, `Game ${appId}`, `game ${appId}`);
}

interface SeedStatus {
  appId: number;
  status: string;
  fetchedAt?: number | null;
}

function seedMetadata(db: AppDatabase, source: MetadataSourceName, entries: SeedStatus[]): void {
  const sql: Record<MetadataSourceName, string> = {
    steamspy: `INSERT INTO steamspy_appdetails (app_id, tags_status, tags_fetched_at, updated_at)
              VALUES (?, ?, ?, 1)
              ON CONFLICT(app_id) DO UPDATE SET
                tags_status = excluded.tags_status,
                tags_fetched_at = excluded.tags_fetched_at`,
    storefront: `INSERT INTO storefront_appdetails (app_id, store_status, store_fetched_at, updated_at)
                 VALUES (?, ?, ?, 1)
                 ON CONFLICT(app_id) DO UPDATE SET
                   store_status = excluded.store_status,
                   store_fetched_at = excluded.store_fetched_at`,
    steam_reviews: `INSERT INTO steam_review_summaries (app_id, review_status, review_fetched_at, updated_at)
                    VALUES (?, ?, ?, 1)
                    ON CONFLICT(app_id) DO UPDATE SET
                      review_status = excluded.review_status,
                      review_fetched_at = excluded.review_fetched_at`,
  };
  const statement = db.raw.prepare(sql[source]);
  for (const entry of entries) {
    statement.run(entry.appId, entry.status, entry.fetchedAt === undefined ? 1 : entry.fetchedAt);
  }
}

function sourceState(
  db: AppDatabase,
  name: MetadataSourceName,
): { status: string; retry_after_at: number | null; last_error: string | null } {
  return db.raw
    .prepare("SELECT status, retry_after_at, last_error FROM source_state WHERE name = ?")
    .get(name) as { status: string; retry_after_at: number | null; last_error: string | null };
}

function scanResult(overrides: Partial<LibraryScanResult> = {}): LibraryScanResult {
  return {
    status: "ok",
    error: null,
    skipped: null,
    stats: {
      libraries: 0,
      manifests: 0,
      localconfigApps: 0,
      upserted: 0,
      deleted: 0,
      warnings: { negativePlaytime: 0 },
    },
    warnings: [],
    ...overrides,
  };
}

describe("POST /api/refresh validation", () => {
  const invalid: Array<{ payload: object; field: string }> = [
    { payload: { scope: "metadata" }, field: "mode" },
    { payload: { scope: "all" }, field: "mode" },
    { payload: { scope: "metadata", mode: "full" }, field: "appIds" },
    { payload: { scope: "metadata", mode: "fetch", appIds: [1] }, field: "appIds" },
    { payload: { scope: "all", mode: "full" }, field: "mode" },
    { payload: { scope: "library", mode: "fetch" }, field: "mode" },
    { payload: { scope: "library", mode: null }, field: "mode" },
    { payload: { scope: "ownership", mode: "full" }, field: "mode" },
    { payload: { scope: "ownership", mode: null }, field: "mode" },
    { payload: { scope: "library", appIds: [1] }, field: "appIds" },
    { payload: { scope: "library", appIds: null }, field: "appIds" },
    { payload: { scope: "ownership", appIds: [1] }, field: "appIds" },
    { payload: { scope: "all", mode: "fetch", appIds: [1] }, field: "appIds" },
    { payload: { scope: "all", mode: "fetch", appIds: null }, field: "appIds" },
    { payload: { scope: "metadata", mode: "fetch", appIds: null }, field: "appIds" },
    { payload: { scope: "metadata", mode: "full", appIds: [] }, field: "appIds" },
    { payload: { scope: "metadata", mode: "full", appIds: [1, 1] }, field: "appIds" },
    { payload: { scope: "metadata", mode: "full", appIds: [1, "2"] }, field: "appIds" },
    { payload: { scope: "metadata", mode: "full", appIds: [0] }, field: "appIds" },
    { payload: { scope: "metadata", mode: "full", appIds: [-1] }, field: "appIds" },
    {
      payload: {
        scope: "metadata",
        mode: "full",
        appIds: Array.from({ length: 5_001 }, (_, index) => index + 1),
      },
      field: "appIds",
    },
    { payload: {}, field: "scope" },
    { payload: { scope: "nope" }, field: "scope" },
  ];

  for (const entry of invalid) {
    it(`rejects ${JSON.stringify(entry.payload).slice(0, 80)} at ${entry.field}`, async () => {
      const test = harness();
      const response = await post(test.app, entry.payload);
      expect(response.statusCode).toBe(422);
      const body = response.json() as {
        error: { code: string; details: { fieldErrors: Record<string, string> } };
      };
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.fieldErrors).toHaveProperty(entry.field);
      expect(test.db.raw.prepare("SELECT COUNT(*) AS count FROM refresh_runs").get()).toEqual({
        count: 0,
      });
    });
  }

  const valid: object[] = [
    { scope: "library" },
    { scope: "metadata", mode: "fetch" },
    { scope: "metadata", mode: "full", appIds: [30, 10, 20] },
    { scope: "all", mode: "fetch" },
  ];

  for (const payload of valid) {
    it(`accepts ${JSON.stringify(payload)}`, async () => {
      const test = harness();
      const { run } = await startAndWait(test, payload);
      expect(run.id).toBeTruthy();
    });
  }

  it("normalizes appIds ascending and persists them only for metadata full", async () => {
    const test = harness();
    const { run } = await startAndWait(test, {
      scope: "metadata",
      mode: "full",
      appIds: [30, 10, 20],
    });
    expect(run.appIds).toEqual([10, 20, 30]);
    const row = test.db.raw
      .prepare("SELECT app_ids_json FROM refresh_runs WHERE id = ?")
      .get(run.id) as { app_ids_json: string };
    expect(JSON.parse(row.app_ids_json)).toEqual([10, 20, 30]);

    const fetch = await startAndWait(test, { scope: "metadata", mode: "fetch" });
    expect(fetch.run.appIds).toBeNull();
    const fetchRow = test.db.raw
      .prepare("SELECT app_ids_json FROM refresh_runs WHERE id = ?")
      .get(fetch.run.id) as { app_ids_json: string | null };
    expect(fetchRow.app_ids_json).toBeNull();
  });
});

describe("Refresh worker and run API", () => {
  it("returns 202 immediately, executes in the background, and supports polling", async () => {
    const gate = new Deferred();
    const source = new FakeSource("steamspy", async () => {
      await gate.promise;
      return { kind: "ok" };
    });
    const test = harness({ sources: [source] });
    seedGame(test.db, 42);

    const response = await post(test.app, { scope: "metadata", mode: "fetch" });
    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toMatch(/^\/api\/refresh\/\d+$/);
    const started = response.json() as { data: RefreshRun };
    expect(["queued", "running"]).toContain(started.data.status);
    expect(started.data.finishedAt).toBeNull();

    await until(() => source.calls.length === 1);
    const polling = (await get(test.app, `/api/refresh/${started.data.id}`)).json() as {
      data: RefreshRun;
    };
    expect(["queued", "running"]).toContain(polling.data.status);
    const status = (await get(test.app, "/api/status")).json() as { data: Status };
    expect(status.data.activeRefresh?.id).toBe(started.data.id);
    expect(status.data.lastRefresh?.id).toBe(started.data.id);

    gate.release();
    await test.refresh.waitForIdle();

    const finished = (await get(test.app, `/api/refresh/${started.data.id}`)).json() as {
      data: RefreshRun;
    };
    expect(finished.data).toMatchObject({
      scope: "metadata",
      mode: "fetch",
      status: "succeeded",
      total: 1,
      done: 1,
      error: null,
    });
    expect(finished.data.stats?.sources.steamspy).toEqual({
      candidates: 1,
      done: 1,
      failed: 0,
      skipped: 0,
    });
    const after = (await get(test.app, "/api/status")).json() as { data: Status };
    expect(after.data.activeRefresh).toBeNull();
    expect(after.data.lastRefresh?.id).toBe(started.data.id);
  });

  it("deduplicates an identical running request and rejects a different one", async () => {
    const gate = new Deferred();
    const source = new FakeSource("steamspy", async () => {
      await gate.promise;
      return { kind: "ok" };
    });
    const test = harness({ sources: [source] });
    seedGame(test.db, 42);

    const first = await post(test.app, { scope: "metadata", mode: "fetch" });
    const firstRun = (first.json() as { data: RefreshRun }).data;
    await until(() => source.calls.length === 1);

    const duplicate = await post(test.app, { scope: "metadata", mode: "fetch" });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({
      data: { id: firstRun.id },
      meta: { deduplicated: true },
    });

    const different = await post(test.app, { scope: "library" });
    expect(different.statusCode).toBe(409);
    expect(different.json()).toMatchObject({
      error: {
        code: "REFRESH_IN_PROGRESS",
        details: { runId: firstRun.id, scope: "metadata", mode: "fetch" },
      },
    });

    gate.release();
    await test.refresh.waitForIdle();

    const repeated = await post(test.app, { scope: "metadata", mode: "fetch" });
    expect(repeated.statusCode).toBe(202);
    expect(repeated.json()).not.toHaveProperty("meta");
    expect((repeated.json() as { data: RefreshRun }).data.id).not.toBe(firstRun.id);
    await test.refresh.waitForIdle();
  });

  it("runs all phases in library, ownership, metadata order", async () => {
    const events: string[] = [];
    const source = new FakeSource("steamspy", () => {
      events.push("metadata");
      return { kind: "ok" };
    });
    const ownershipSource: SteamOwnershipSource = {
      async fetchOwnedGames(): Promise<OwnershipFetchResult> {
        events.push("ownership");
        return {
          kind: "complete",
          gameCount: 1,
          games: [
            { appId: 42, name: "Game 42", playtimeForeverMinutes: 0, playtime2WeeksMinutes: null },
          ],
        };
      },
    };
    const test = harness({
      sources: [source],
      ownershipSource,
      scan: () => {
        events.push("library");
        return scanResult();
      },
    });
    seedGame(test.db, 42);

    const { run } = await startAndWait(test, { scope: "all", mode: "fetch" });

    expect(events).toEqual(["library", "ownership", "metadata"]);
    expect(run.status).toBe("succeeded");
  });

  it("skips ownership and finishes partial when ownership is not configured", async () => {
    let scanned = false;
    const source = new FakeSource("steamspy");
    const test = harness({
      sources: [source],
      steamApiKey: null,
      steamId64: null,
      scan: () => {
        scanned = true;
        return scanResult();
      },
    });

    const { run } = await startAndWait(test, { scope: "all", mode: "fetch" });

    expect(scanned).toBe(true);
    expect(source.calls).toEqual([]);
    expect(run).toMatchObject({
      status: "partial",
      total: 0,
      done: 0,
      error: { code: "OWNERSHIP_NOT_CONFIGURED" },
    });
    expect(run.stats?.sources).toEqual({
      steamspy: { candidates: 0, done: 0, failed: 0, skipped: 0 },
      storefront: { candidates: 0, done: 0, failed: 0, skipped: 0 },
      steam_reviews: { candidates: 0, done: 0, failed: 0, skipped: 0 },
    });
  });

  it("still scans and makes one ownership request when Metadata has no pending work", async () => {
    let scans = 0;
    let ownershipCalls = 0;
    const source = new FakeSource("steamspy");
    const test = harness({
      sources: [source],
      ownershipSource: {
        async fetchOwnedGames() {
          ownershipCalls += 1;
          return {
            kind: "complete",
            gameCount: 1,
            games: [
              {
                appId: 1,
                name: "Game 1",
                playtimeForeverMinutes: 0,
                playtime2WeeksMinutes: null,
              },
            ],
          };
        },
      },
      scan: () => {
        scans += 1;
        return scanResult();
      },
    });
    seedGame(test.db, 1);
    seedMetadata(test.db, "steamspy", [{ appId: 1, status: "ok" }]);

    const { run } = await startAndWait(test, { scope: "all", mode: "fetch" });

    expect(scans).toBe(1);
    expect(ownershipCalls).toBe(1);
    expect(source.calls).toEqual([]);
    expect(run).toMatchObject({ status: "succeeded", total: 0, done: 0 });
    expect(run.stats?.sources.steamspy.candidates).toBe(0);
  });
});

describe("Metadata pacing", () => {
  it("paces SteamSpy serially at about one request per second without delaying the first", async () => {
    const steamspy = new FakeSource("steamspy");
    const test = harness({ sources: [steamspy] });
    for (const appId of [1, 2, 3]) {
      seedGame(test.db, appId);
    }

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(run.status).toBe("succeeded");
    expect(steamspy.times).toEqual([NOW, NOW + 1, NOW + 2]);
    expect(test.clock.sleeps).toEqual([1_000, 1_000]);
  });

  it("paces reviews on their own 1.5-second Web API interval", async () => {
    const reviews = new FakeSource("steam_reviews", () => ({ kind: "ok" }), "web_api");
    const test = harness({ sources: [reviews] });
    for (const appId of [1, 2, 3]) {
      seedGame(test.db, appId);
    }

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(run.status).toBe("succeeded");
    expect(reviews.times).toEqual([NOW, NOW + 1.5, NOW + 3]);
    expect(test.clock.sleeps).toEqual([1_500, 1_500]);
  });

  it("does not delay the first request on separate store and Web API hosts", async () => {
    const storefront = new FakeSource("storefront", () => ({ kind: "ok" }), "store");
    const reviews = new FakeSource("steam_reviews", () => ({ kind: "ok" }), "web_api");
    const test = harness({ sources: [storefront, reviews] });
    seedGame(test.db, 1);

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(run.status).toBe("succeeded");
    expect(storefront.times).toEqual([NOW]);
    expect(reviews.times).toEqual([NOW]);
    expect(test.clock.sleeps).toEqual([]);
  });

  it("never delays the first request for a host", async () => {
    const steamspy = new FakeSource("steamspy");
    const storefront = new FakeSource("storefront", () => ({ kind: "ok" }), "store");
    const test = harness({ sources: [steamspy, storefront] });
    seedGame(test.db, 1);

    await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(steamspy.times).toEqual([NOW]);
    expect(storefront.times).toEqual([NOW]);
    expect(test.clock.sleeps).toEqual([]);
  });
});

describe("Metadata Fetch selection", () => {
  it("selects pending sources per Game and skips ok, unavailable, and settled missing", async () => {
    const steamspy = new FakeSource("steamspy");
    const storefront = new FakeSource("storefront");
    const reviews = new FakeSource("steam_reviews");
    const test = harness({ sources: [steamspy, storefront, reviews] });

    for (const appId of [1, 2, 3, 4, 5]) {
      seedGame(test.db, appId);
    }
    // 1: no rows at all.
    // 2: tags ok, store error, reviews unavailable.
    seedMetadata(test.db, "steamspy", [{ appId: 2, status: "ok" }]);
    seedMetadata(test.db, "storefront", [{ appId: 2, status: "error" }]);
    seedMetadata(test.db, "steam_reviews", [{ appId: 2, status: "unavailable" }]);
    // 3: never-attempted miss (pending), settled store miss, stale reviews.
    seedMetadata(test.db, "steamspy", [{ appId: 3, status: "missing", fetchedAt: null }]);
    seedMetadata(test.db, "storefront", [{ appId: 3, status: "missing", fetchedAt: 10 }]);
    seedMetadata(test.db, "steam_reviews", [{ appId: 3, status: "stale" }]);
    // 4: settled miss, ok, settled review miss.
    seedMetadata(test.db, "steamspy", [{ appId: 4, status: "missing", fetchedAt: 10 }]);
    seedMetadata(test.db, "storefront", [{ appId: 4, status: "ok" }]);
    seedMetadata(test.db, "steam_reviews", [{ appId: 4, status: "missing", fetchedAt: 10 }]);
    // 5: settled everywhere.
    seedMetadata(test.db, "steamspy", [{ appId: 5, status: "ok" }]);
    seedMetadata(test.db, "storefront", [{ appId: 5, status: "unavailable" }]);
    seedMetadata(test.db, "steam_reviews", [{ appId: 5, status: "ok" }]);

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(steamspy.calls).toEqual([1, 3]);
    expect(storefront.calls).toEqual([1, 2]);
    expect(reviews.calls).toEqual([1, 3]);
    expect(run.status).toBe("succeeded");
    expect(run.total).toBe(3);
    expect(run.done).toBe(3);
    expect(run.stats?.sources).toEqual({
      steamspy: { candidates: 2, done: 2, failed: 0, skipped: 0 },
      storefront: { candidates: 2, done: 2, failed: 0, skipped: 0 },
      steam_reviews: { candidates: 2, done: 2, failed: 0, skipped: 0 },
    });
  });

  it("skips a source in retry_after_at, records skipped work, and finishes partial", async () => {
    const storefront = new FakeSource("storefront");
    const test = harness({ sources: [storefront] });
    seedGame(test.db, 1);
    test.db.raw
      .prepare(
        `UPDATE source_state SET status = 'rate_limited', retry_after_at = ?
         WHERE name = 'storefront'`,
      )
      .run(NOW + 120);

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(storefront.calls).toEqual([]);
    expect(run.status).toBe("partial");
    expect(run.total).toBe(1);
    expect(run.done).toBe(1);
    expect(run.stats?.sources.storefront).toEqual({
      candidates: 1,
      done: 0,
      failed: 0,
      skipped: 1,
    });
    expect(sourceState(test.db, "storefront").retry_after_at).toBe(NOW + 120);
  });

  it("completes a metadata Fetch with no pending work without a request", async () => {
    const steamspy = new FakeSource("steamspy");
    const storefront = new FakeSource("storefront");
    const reviews = new FakeSource("steam_reviews");
    const test = harness({ sources: [steamspy, storefront, reviews] });
    seedGame(test.db, 1);
    seedMetadata(test.db, "steamspy", [{ appId: 1, status: "ok" }]);
    seedMetadata(test.db, "storefront", [{ appId: 1, status: "unavailable" }]);
    seedMetadata(test.db, "steam_reviews", [{ appId: 1, status: "missing", fetchedAt: 10 }]);

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect([...steamspy.calls, ...storefront.calls, ...reviews.calls]).toEqual([]);
    expect(run).toMatchObject({ status: "succeeded", total: 0, done: 0 });
    expect(run.stats?.sources.steamspy.candidates).toBe(0);
  });
});

describe("Metadata Full Refresh", () => {
  it("requests every source for every selected Game and counts missing App IDs as skipped", async () => {
    const steamspy = new FakeSource("steamspy");
    const storefront = new FakeSource("storefront");
    const reviews = new FakeSource("steam_reviews");
    const test = harness({ sources: [steamspy, storefront, reviews] });
    seedGame(test.db, 10);
    seedMetadata(test.db, "steamspy", [{ appId: 10, status: "ok" }]);
    seedMetadata(test.db, "storefront", [{ appId: 10, status: "unavailable" }]);
    seedMetadata(test.db, "steam_reviews", [{ appId: 10, status: "ok" }]);

    const { run } = await startAndWait(test, {
      scope: "metadata",
      mode: "full",
      appIds: [10, 99],
    });

    expect(steamspy.calls).toEqual([10]);
    expect(storefront.calls).toEqual([10]);
    expect(reviews.calls).toEqual([10]);
    expect(run.status).toBe("partial");
    expect(run.total).toBe(2);
    expect(run.done).toBe(2);
    expect(run.stats?.sources).toEqual({
      steamspy: { candidates: 2, done: 1, failed: 0, skipped: 1 },
      storefront: { candidates: 2, done: 1, failed: 0, skipped: 1 },
      steam_reviews: { candidates: 2, done: 1, failed: 0, skipped: 1 },
    });
  });
});

describe("Metadata progress and failure", () => {
  it("persists monotonic Game progress at most every 25 items", async () => {
    const observed: number[] = [];
    let test!: Harness;
    const source = new FakeSource("steamspy", () => {
      const row = test.db.raw
        .prepare("SELECT done FROM refresh_runs ORDER BY id DESC LIMIT 1")
        .get() as { done: number };
      observed.push(row.done);
      const completed = source.calls.length - 1;
      expect(completed - row.done).toBeLessThanOrEqual(24);
      return { kind: "ok" };
    });
    test = harness({ sources: [source] });
    for (let appId = 1; appId <= 60; appId += 1) {
      seedGame(test.db, appId);
    }

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(run).toMatchObject({ status: "succeeded", total: 60, done: 60 });
    expect(run.stats?.sources.steamspy).toEqual({
      candidates: 60,
      done: 60,
      failed: 0,
      skipped: 0,
    });
    for (let index = 1; index < observed.length; index += 1) {
      expect(observed[index]!).toBeGreaterThanOrEqual(observed[index - 1]!);
    }
    expect(observed).toContain(25);
    expect(observed).toContain(50);
  });

  it("records a source failure as partial and keeps other source data", async () => {
    const storefront = new FakeSource("storefront", () => ({
      kind: "error",
      message: "The store failed.",
    }));
    const test = harness({ sources: [storefront] });
    for (const appId of [1, 2, 3]) {
      seedGame(test.db, appId);
    }
    seedMetadata(test.db, "steamspy", [{ appId: 1, status: "ok" }]);
    test.db.raw
      .prepare(
        `INSERT INTO storefront_appdetails (app_id, metacritic_score, store_status, updated_at)
         VALUES (1, 91, 'error', 1)`,
      )
      .run();

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(storefront.calls).toEqual([1, 1, 1, 1, 1]);
    expect(run.status).toBe("partial");
    expect(run.stats?.sources.storefront).toEqual({
      candidates: 3,
      done: 0,
      failed: 1,
      skipped: 2,
    });
    const state = sourceState(test.db, "storefront");
    expect(state.status).toBe("error");
    expect(state.retry_after_at).toBe(NOW + 900);
    expect(test.db.raw.prepare("SELECT metacritic_score FROM storefront_appdetails").get()).toEqual(
      {
        metacritic_score: 91,
      },
    );
    expect(test.db.raw.prepare("SELECT COUNT(*) AS count FROM steamspy_appdetails").get()).toEqual({
      count: 1,
    });
  });

  it("honours 429 Retry-After and pauses only the affected host", async () => {
    const storefront = new FakeSource(
      "storefront",
      () => ({
        kind: "rate_limited",
        retryAfterAt: NOW + 120,
        message: "Slow down.",
      }),
      "store",
    );
    const reviews = new FakeSource("steam_reviews", () => ({ kind: "ok" }), "web_api");
    const test = harness({ sources: [storefront, reviews] });
    for (const appId of [1, 2, 3]) {
      seedGame(test.db, appId);
    }

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(storefront.calls).toEqual([1]);
    expect(reviews.calls).toEqual([1, 2, 3]);
    expect(run.status).toBe("partial");
    expect(run.stats?.sources.storefront.skipped).toBe(3);
    expect(run.stats?.sources.steam_reviews.skipped).toBe(0);
    expect(sourceState(test.db, "storefront")).toMatchObject({
      status: "rate_limited",
      retry_after_at: NOW + 120,
    });
    expect(sourceState(test.db, "steam_reviews")).toMatchObject({ status: "ok" });
  });

  it("maps a pass skipped by a 403 block to blocked and leaves the other host running", async () => {
    const storefront = new FakeSource(
      "storefront",
      () => ({ kind: "blocked", message: "Challenge detected." }),
      "store",
    );
    const reviews = new FakeSource("steam_reviews", () => ({ kind: "ok" }), "web_api");
    const test = harness({ sources: [storefront, reviews] });
    for (const appId of [1, 2]) {
      seedGame(test.db, appId);
    }

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(storefront.calls).toEqual([1]);
    expect(reviews.calls).toEqual([1, 2]);
    expect(run.status).toBe("partial");
    expect(sourceState(test.db, "storefront")).toMatchObject({
      status: "blocked",
      retry_after_at: NOW + 900,
    });
    expect(sourceState(test.db, "steam_reviews")).toMatchObject({ status: "ok" });
    expect(run.stats?.sources.storefront.skipped).toBe(2);
    expect(run.stats?.sources.steam_reviews.skipped).toBe(0);
  });

  it("blocks a source for 15 minutes on a challenge", async () => {
    const steamspy = new FakeSource("steamspy", () => ({
      kind: "blocked",
      message: "Challenge detected.",
    }));
    const test = harness({ sources: [steamspy] });
    seedGame(test.db, 1);

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(run.status).toBe("partial");
    expect(sourceState(test.db, "steamspy")).toMatchObject({
      status: "blocked",
      retry_after_at: NOW + 900,
    });
  });

  it("marks a single-item run partial when the source exhausts retries", async () => {
    const steamspy = new FakeSource("steamspy", () => ({
      kind: "error",
      message: "Temporary failure.",
    }));
    const test = harness({ sources: [steamspy], jitter: 0.5 });
    seedGame(test.db, 1);

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(steamspy.calls).toEqual([1, 1, 1, 1, 1]);
    expect(run.status).toBe("partial");
    expect(run.stats?.sources.steamspy).toEqual({
      candidates: 1,
      done: 0,
      failed: 1,
      skipped: 0,
    });
    // Five consecutive failures open the source circuit for 15 minutes.
    expect(sourceState(test.db, "steamspy")).toMatchObject({
      status: "error",
      retry_after_at: test.clock.seconds + 900,
    });
  });

  it("records a non-retryable single-item failure as partial without retrying", async () => {
    const storefront = new FakeSource("storefront", () => ({
      kind: "error",
      message: "The request shape was rejected.",
      retryable: false,
    }));
    const test = harness({ sources: [storefront] });
    seedGame(test.db, 1);

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(storefront.calls).toEqual([1]);
    expect(run.status).toBe("partial");
    expect(run.stats?.sources.storefront).toEqual({
      candidates: 1,
      done: 0,
      failed: 1,
      skipped: 0,
    });
    expect(sourceState(test.db, "storefront")).toMatchObject({
      status: "error",
      retry_after_at: null,
    });
  });

  it("retries 5xx with full jitter and succeeds on a later attempt", async () => {
    let attempts = 0;
    const steamspy = new FakeSource("steamspy", () => {
      attempts += 1;
      return attempts < 5 ? { kind: "error", message: "Temporary failure." } : { kind: "ok" };
    });
    const test = harness({ sources: [steamspy], jitter: 0.5 });
    seedGame(test.db, 1);

    const { run } = await startAndWait(test, { scope: "metadata", mode: "fetch" });

    expect(attempts).toBe(5);
    expect(test.clock.sleeps).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(run).toMatchObject({ status: "succeeded", total: 1, done: 1 });
    expect(sourceState(test.db, "steamspy").status).toBe("ok");
  });

  it("runs storefront and reviews concurrently on separate hosts", async () => {
    const gate = new Deferred();
    const events: string[] = [];
    const storefront = new FakeSource(
      "storefront",
      async () => {
        events.push("storefront:start");
        await gate.promise;
        events.push("storefront:end");
        return { kind: "ok" };
      },
      "store",
    );
    const reviews = new FakeSource(
      "steam_reviews",
      () => {
        events.push("reviews:start");
        events.push("reviews:end");
        return { kind: "ok" };
      },
      "web_api",
    );
    const test = harness({ sources: [storefront, reviews] });
    seedGame(test.db, 1);

    const started = await post(test.app, { scope: "metadata", mode: "fetch" });
    expect(started.statusCode).toBe(202);
    await until(() => events.includes("storefront:start"));
    await until(() => events.includes("reviews:end"));
    expect(events).toContain("reviews:start");
    expect(events).not.toContain("storefront:end");
    expect(reviews.calls).toEqual([1]);

    gate.release();
    await test.refresh.waitForIdle();
    expect(events).toContain("storefront:start");
    expect(events).toContain("storefront:end");
    expect(events).toContain("reviews:start");
    expect(events).toContain("reviews:end");
  });
});

describe("Run recovery and progress timestamps", () => {
  it("marks queued and running runs INTERRUPTED, using lastProgressAt for finished_at", () => {
    const test = harness();
    const stats = JSON.stringify({
      sources: {
        steamspy: { candidates: 1, done: 0, failed: 0, skipped: 0 },
        storefront: { candidates: 1, done: 0, failed: 0, skipped: 0 },
        steam_reviews: { candidates: 1, done: 0, failed: 0, skipped: 0 },
      },
      lastProgressAt: 1_699_999_000,
    });
    test.db.raw
      .prepare(
        `INSERT INTO refresh_runs (scope, mode, status, started_at, done, stats_json)
         VALUES ('metadata', 'fetch', 'running', 1, 0, ?)`,
      )
      .run(stats);
    test.db.raw
      .prepare(
        `INSERT INTO refresh_runs (scope, mode, status, started_at, done)
         VALUES ('library', NULL, 'queued', 2, 0)`,
      )
      .run();

    expect(test.refresh.recoverInterruptedRuns()).toBe(2);

    const rows = test.db.raw
      .prepare(
        `SELECT id, status, error_code, finished_at, done, stats_json
         FROM refresh_runs ORDER BY id ASC`,
      )
      .all() as Array<{
      id: number;
      status: string;
      error_code: string;
      finished_at: number;
      done: number;
      stats_json: string | null;
    }>;
    expect(rows[0]).toMatchObject({
      status: "failed",
      error_code: "INTERRUPTED",
      finished_at: 1_699_999_000,
      done: 0,
    });
    expect(rows[0]?.stats_json).toBe(stats);
    expect(rows[1]).toMatchObject({
      status: "failed",
      error_code: "INTERRUPTED",
      finished_at: NOW,
    });
  });

  it("marks the active run INTERRUPTED on graceful shutdown", async () => {
    const gate = new Deferred();
    const source = new FakeSource("steamspy", async () => {
      await gate.promise;
      return { kind: "ok" };
    });
    const test = harness({ sources: [source] });
    seedGame(test.db, 1);

    const response = await post(test.app, { scope: "metadata", mode: "fetch" });
    const run = (response.json() as { data: RefreshRun }).data;
    await until(() => source.calls.length === 1);

    const closing = test.refresh.shutdown();
    gate.release();
    await closing;

    const row = test.db.raw
      .prepare("SELECT status, error_code, finished_at FROM refresh_runs WHERE id = ?")
      .get(run.id) as { status: string; error_code: string; finished_at: number };
    expect(row).toMatchObject({
      status: "failed",
      error_code: "INTERRUPTED",
      finished_at: NOW,
    });
  });

  it("uses the latest local scan source state for lastScanAt and lastScanStatus", () => {
    const test = harness();
    expect(new GamesRepository(test.db.raw).scanState()).toEqual({
      lastScanAt: null,
      lastScanStatus: "never",
    });

    test.db.raw
      .prepare(
        `UPDATE source_state SET status = 'ok', last_attempt_at = 100
         WHERE name = 'steam_local'`,
      )
      .run();
    expect(new GamesRepository(test.db.raw).scanState()).toEqual({
      lastScanAt: 100,
      lastScanStatus: "ok",
    });

    test.db.raw
      .prepare(
        `UPDATE source_state SET status = 'partial', last_attempt_at = 400
         WHERE name = 'steam_local'`,
      )
      .run();
    expect(new GamesRepository(test.db.raw).scanState()).toEqual({
      lastScanAt: 400,
      lastScanStatus: "partial",
    });

    test.db.raw
      .prepare(
        `UPDATE source_state SET status = 'error', last_attempt_at = 500
         WHERE name = 'steam_local'`,
      )
      .run();
    expect(new GamesRepository(test.db.raw).scanState()).toEqual({
      lastScanAt: 500,
      lastScanStatus: "failed",
    });
  });
});

describe("all-run phase evidence", () => {
  function allHarness(options: {
    scan?: typeof scanLocalLibrary;
    ownershipSource?: SteamOwnershipSource;
    sources?: MetadataSource[];
  }): Harness {
    return harness(options);
  }

  it("feeds library, ownership, and Metadata status from an all run", async () => {
    const source = new FakeSource("steamspy");
    const test = allHarness({
      sources: [source],
      scan: () =>
        scanResult({
          stats: {
            libraries: 1,
            manifests: 1,
            localconfigApps: 1,
            upserted: 1,
            deleted: 0,
            warnings: { negativePlaytime: 2 },
          },
        }),
      ownershipSource: {
        async fetchOwnedGames() {
          return {
            kind: "complete",
            gameCount: 1,
            games: [
              {
                appId: 42,
                name: "Game 42",
                playtimeForeverMinutes: 0,
                playtime2WeeksMinutes: null,
              },
            ],
          };
        },
      },
    });
    seedGame(test.db, 42);

    const { run } = await startAndWait(test, { scope: "all", mode: "fetch" });
    expect(run.status).toBe("succeeded");

    const status = buildStatus({
      discovery,
      steamApiKey: "SECRET_KEY",
      configuredSteamId64: TEST_STEAM_ID64,
      schemaVersion: test.db.schemaVersion,
      db: test.db.raw,
    });
    const isoNow = new Date(NOW * 1000).toISOString().replace(".000Z", "Z");
    expect(status.library).toMatchObject({
      lastScanAt: isoNow,
      lastScanStatus: "ok",
    });
    expect(status.ownership.error).toBeNull();
    expect(status.metadata.lastSuccessAt).toBe(isoNow);
    expect((await get(test.app, "/api/games")).json()).toMatchObject({
      meta: { dataAsOf: isoNow },
    });

    const row = test.db.raw
      .prepare("SELECT stats_json FROM refresh_runs WHERE id = ?")
      .get(run.id) as { stats_json: string };
    expect(JSON.parse(row.stats_json)).toMatchObject({
      warnings: { negativePlaytime: 2 },
    });
    // AC-L9 stays internal: the API exposes only the documented counters.
    expect(run.stats).not.toHaveProperty("warnings");
  });

  it("reports the last ownership failure from an all run", async () => {
    const test = allHarness({
      sources: [],
      scan: () => scanResult(),
      ownershipSource: {
        async fetchOwnedGames() {
          return {
            kind: "rate_limited",
            retryAfterAt: NOW + 120,
            message: "The Steam Web API is rate limiting this Account.",
          };
        },
      },
    });
    seedGame(test.db, 1);

    const { run } = await startAndWait(test, { scope: "all", mode: "fetch" });
    expect(run).toMatchObject({ status: "partial", error: { code: "RATE_LIMITED" } });

    const status = buildStatus({
      discovery,
      steamApiKey: "SECRET_KEY",
      configuredSteamId64: TEST_STEAM_ID64,
      schemaVersion: test.db.schemaVersion,
      db: test.db.raw,
    });
    expect(status.ownership.state).toBe("rate_limited");
    expect(status.ownership.error).toEqual({
      code: "RATE_LIMITED",
      message: "The Steam Web API is rate limiting this Account.",
    });
  });

  it("reports a partial local scan from an all run", async () => {
    const test = allHarness({
      sources: [],
      scan: () =>
        scanResult({
          status: "partial",
          error: { code: "SCAN_PARTIAL", message: "One library could not be read." },
        }),
      ownershipSource: {
        async fetchOwnedGames() {
          return { kind: "empty", gameCount: 0, games: [] };
        },
      },
    });

    const { run } = await startAndWait(test, { scope: "all", mode: "fetch" });
    expect(run.status).toBe("partial");

    const status = buildStatus({
      discovery,
      steamApiKey: "SECRET_KEY",
      configuredSteamId64: TEST_STEAM_ID64,
      schemaVersion: test.db.schemaVersion,
      db: test.db.raw,
    });
    expect(status.library.lastScanStatus).toBe("partial");
    expect(status.library.lastScanAt).toBe(
      new Date(NOW * 1000).toISOString().replace(".000Z", "Z"),
    );
  });
});

describe("Status metadata and source health", () => {
  it("classifies every Game once per source and keeps five ordered SourceHealth rows", () => {
    const test = harness();
    seedGame(test.db, 1);
    seedGame(test.db, 2);
    seedGame(test.db, 3);
    seedMetadata(test.db, "steamspy", [{ appId: 1, status: "ok" }]);
    seedMetadata(test.db, "steamspy", [{ appId: 2, status: "stale" }]);
    seedMetadata(test.db, "storefront", [{ appId: 1, status: "unavailable" }]);
    seedMetadata(test.db, "steam_reviews", [{ appId: 1, status: "unavailable" }]);
    test.db.raw
      .prepare(
        `UPDATE source_state SET status = 'ok', last_success_at = ?
         WHERE name = 'storefront'`,
      )
      .run(NOW);
    test.db.raw
      .prepare(
        `UPDATE source_state SET status = 'rate_limited', retry_after_at = ?
         WHERE name = 'steamspy'`,
      )
      .run(NOW + 60);

    const status = buildStatus({
      discovery,
      steamApiKey: null,
      configuredSteamId64: TEST_STEAM_ID64,
      schemaVersion: test.db.schemaVersion,
      db: test.db.raw,
    });

    expect(status.sources.map((source) => source.name)).toEqual([
      "steam_local",
      "steam_web_api",
      "steamspy",
      "storefront",
      "steam_reviews",
    ]);
    expect(status.metadata.tags).toEqual({ ok: 1, missing: 1, stale: 1, error: 0 });
    expect(status.metadata.store).toEqual({
      ok: 0,
      unavailable: 1,
      missing: 2,
      stale: 0,
      error: 0,
    });
    expect(status.metadata.reviews).toEqual({
      ok: 0,
      unavailable: 1,
      missing: 2,
      stale: 0,
      error: 0,
    });
    expect(status.metadata.lastSuccessAt).toBe(
      new Date(NOW * 1000).toISOString().replace(".000Z", "Z"),
    );
    expect(status.sources.find((source) => source.name === "steamspy")).toMatchObject({
      status: "rate_limited",
      retryAfterAt: new Date((NOW + 60) * 1000).toISOString().replace(".000Z", "Z"),
    });
  });
});

describe("Startup Refresh trigger", () => {
  function serverOptions(dataDir: string, overrides: Record<string, unknown> = {}) {
    return {
      dataDir,
      port: 0,
      openBrowser: false,
      env: {} as NodeJS.ProcessEnv,
      homedir: mkdtempSync(join(tmpdir(), "game-cat-refresh-home-")),
      platform: "linux" as NodeJS.Platform,
      clientDir: null,
      logLevel: "error",
      logToStderr: false,
      ...overrides,
    };
  }

  function temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
    dataDirs.push(dir);
    return dir;
  }

  it("starts nothing without a Web API key", async () => {
    const server = await createServer(serverOptions(temp("game-cat-refresh-nokey")));
    servers.push(server);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const row = server.database.raw.prepare("SELECT COUNT(*) AS count FROM refresh_runs").get() as {
      count: number;
    };
    expect(row.count).toBe(0);
  });

  it("honours the startupRefresh test seam", async () => {
    const server = await createServer(
      serverOptions(temp("game-cat-refresh-seam"), {
        steamApiKey: "SECRET_KEY",
        startupRefresh: false,
      }),
    );
    servers.push(server);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const row = server.database.raw.prepare("SELECT COUNT(*) AS count FROM refresh_runs").get() as {
      count: number;
    };
    expect(row.count).toBe(0);
  });

  it("starts one all + Fetch after listening when a key is configured", async () => {
    const server = await createServer(
      serverOptions(temp("game-cat-refresh-startup"), { steamApiKey: "SECRET_KEY" }),
    );
    servers.push(server);
    const readRun = () =>
      server.database.raw.prepare("SELECT * FROM refresh_runs ORDER BY id DESC LIMIT 1").get() as
        | {
            scope: string;
            mode: string | null;
            status: string;
            error_code: string | null;
          }
        | undefined;
    await until(() => {
      const row = readRun();
      return row !== undefined && row.status !== "queued" && row.status !== "running";
    });
    expect(readRun()).toMatchObject({
      scope: "all",
      mode: "fetch",
      status: "partial",
      error_code: "OWNERSHIP_NOT_CONFIGURED",
    });
  });
});
