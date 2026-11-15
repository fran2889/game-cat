import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../../src/server/db/database.ts";
import { scanLocalLibrary } from "../../src/server/library/scan.ts";
import { readRefreshRun, RefreshService } from "../../src/server/refresh/service.ts";
import {
  parseReleaseYear,
  StorefrontSource,
  type FetchLike,
} from "../../src/server/steam/storefront.ts";
import type { MetadataSourceOutcome } from "../../src/server/refresh/sources.ts";
import { SteamFixture, TEST_STEAM_ID64 } from "../helpers/steam-fixture.ts";

const NOW = 1_700_000_000;

const dataDirs: string[] = [];
const databases: AppDatabase[] = [];
const fixtures: SteamFixture[] = [];

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

function database(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-storefront-"));
  dataDirs.push(dir);
  const db = openAppDatabase({ dataDir: dir, steamWebApiConfigured: false });
  databases.push(db);
  return db;
}

function fixture(): SteamFixture {
  const steam = new SteamFixture();
  fixtures.push(steam);
  return steam;
}

function seedGame(
  db: AppDatabase,
  appId: number,
  options: { name?: string; nameSource?: string } = {},
): void {
  const name = options.name ?? `Game ${appId}`;
  db.raw
    .prepare(
      `INSERT INTO games (
         app_id, name, name_key, name_source, ownership_status,
         playtime_minutes, source_mask, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, 'owned', 0, 1, 1, 1)`,
    )
    .run(appId, name, name.toLowerCase(), options.nameSource ?? "local");
}

function seedStorefront(db: AppDatabase, appId: number): void {
  db.raw
    .prepare(
      `INSERT INTO storefront_appdetails (
         app_id, type, developers_json, publishers_json, genres_json, categories_json,
         platforms_json, release_date_raw, release_year, metacritic_score,
         store_status, store_fetched_at, raw_store_json, updated_at
       ) VALUES (?, 'game', '["Valve"]', '["Valve"]', '["Action"]', '["Single-player"]',
                 '{"windows":true}', 'Apr 18, 2011', 2011, 95, 'ok', ?, '{"cached":true}', ?)`,
    )
    .run(appId, NOW - 100, NOW - 100);
}

function row(db: AppDatabase, appId: number): Record<string, unknown> | undefined {
  return db.raw.prepare("SELECT * FROM storefront_appdetails WHERE app_id = ?").get(appId) as
    Record<string, unknown> | undefined;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function payload(appId: number, data: Record<string, unknown>) {
  return { [String(appId)]: { success: true, data } };
}

function source(response: Response | (() => Response)): {
  source: StorefrontSource;
  requests: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init });
    return typeof response === "function" ? response() : response;
  };
  return { source: new StorefrontSource({ fetch }), requests };
}

async function fetchStorefront(
  db: AppDatabase,
  sourceValue: StorefrontSource,
  appId = 620,
): Promise<MetadataSourceOutcome> {
  return sourceValue.fetch({ db: db.raw, game: { appId, name: `Game ${appId}` }, now: NOW });
}

function fullPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "game",
    name: "Portal 2",
    steam_appid: 620,
    developers: ["Valve"],
    publishers: ["Valve", "Valve"],
    genres: [
      { id: "1", description: "Action" },
      { id: "2", description: "Adventure" },
    ],
    categories: [
      { id: 2, description: "Single-player" },
      { id: 1, description: "Multi-player" },
      { id: 2, description: "Single-player" },
      { id: 51, description: "Steam Workshop" },
      { id: 30, description: "Steam Workshop" },
    ],
    platforms: { windows: true, mac: false, linux: true },
    metacritic: { score: 95, url: "https://example.test/metacritic" },
    release_date: { coming_soon: false, date: "18 Apr, 2011" },
    ...overrides,
  };
}

describe("StorefrontSource request and success persistence", () => {
  it("requests the exact URL with a descriptive User-Agent and stores every field", async () => {
    const db = database();
    seedGame(db, 620);
    const { source: storefront, requests } = source(json(payload(620, fullPayload())));

    const outcome = await fetchStorefront(db, storefront);
    expect(outcome).toEqual({ kind: "ok" });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "https://store.steampowered.com/api/appdetails?appids=620&cc=us&l=english" +
        "&filters=basic,developers,publishers,genres,categories,release_date,metacritic,platforms",
    );
    const headers = new Headers(requests[0]!.init?.headers);
    expect(headers.get("user-agent")).toMatch(/^game-cat\/\S+ \(local Steam library app\)$/);
    expect(headers.get("user-agent")).not.toMatch(/Mozilla|Chrome|Safari/);

    const stored = row(db, 620)!;
    expect(stored).toMatchObject({
      type: "game",
      developers_json: '["Valve"]',
      publishers_json: '["Valve","Valve"]',
      genres_json: '["Action","Adventure"]',
      categories_json: '["Single-player","Multi-player","Steam Workshop","Steam Workshop"]',
      platforms_json: '{"windows":true,"mac":false,"linux":true}',
      release_date_raw: "18 Apr, 2011",
      release_year: 2011,
      metacritic_score: 95,
      store_status: "ok",
      store_fetched_at: NOW,
      store_error: null,
      updated_at: NOW,
    });
    expect(JSON.parse(stored.raw_store_json as string)).toMatchObject({ name: "Portal 2" });

    const game = db.raw.prepare("SELECT name, name_key, name_source FROM games").get() as {
      name: string;
      name_key: string;
      name_source: string;
    };
    expect(game).toEqual({ name: "Portal 2", name_key: "portal 2", name_source: "storefront" });
  });

  it("lets storefront replace every prior name source, including its own", async () => {
    for (const prior of ["placeholder", "local", "steam_web_api", "steamspy", "storefront"]) {
      const db = database();
      seedGame(db, 620, { name: "Old Name", nameSource: prior });
      const { source: storefront } = source(json(payload(620, fullPayload({ name: "Portal 2" }))));

      expect(await fetchStorefront(db, storefront)).toEqual({ kind: "ok" });
      expect(db.raw.prepare("SELECT name, name_key, name_source FROM games").get()).toEqual({
        name: "Portal 2",
        name_key: "portal 2",
        name_source: "storefront",
      });
    }
  });

  it("keeps the prior name when the incoming name is empty", async () => {
    const db = database();
    seedGame(db, 620, { name: "Existing", nameSource: "storefront" });
    const { source: storefront } = source(json(payload(620, fullPayload({ name: "  " }))));

    expect(await fetchStorefront(db, storefront)).toEqual({ kind: "ok" });
    expect(db.raw.prepare("SELECT name, name_source FROM games").get()).toEqual({
      name: "Existing",
      name_source: "storefront",
    });
  });
});

describe("StorefrontSource App ID identity", () => {
  const accepted: Array<[string, Record<string, unknown>]> = [
    ["missing steam_appid", fullPayload({ steam_appid: undefined })],
    ["numeric-string steam_appid", fullPayload({ steam_appid: "620" })],
    ["null steam_appid", fullPayload({ steam_appid: null })],
    ["object steam_appid", fullPayload({ steam_appid: { id: 620 } })],
    ["non-integer steam_appid", fullPayload({ steam_appid: 620.5 })],
    ["zero steam_appid", fullPayload({ steam_appid: 0 })],
  ];

  for (const [label, data] of accepted) {
    it(`accepts a response keyed by the requested App ID with ${label}`, async () => {
      const db = database();
      seedGame(db, 620);
      const { source: storefront } = source(json(payload(620, data)));

      expect(await fetchStorefront(db, storefront, 620)).toEqual({ kind: "ok" });
      expect(row(db, 620)).toMatchObject({
        store_status: "ok",
        store_fetched_at: NOW,
        store_error: null,
        metacritic_score: 95,
        release_year: 2011,
      });
      expect(db.raw.prepare("SELECT name, name_source FROM games").get()).toEqual({
        name: "Portal 2",
        name_source: "storefront",
      });
    });
  }
});

describe("StorefrontSource unavailable responses", () => {
  const unavailable: Array<[string, unknown]> = [
    ["success false", { "620": { success: false } }],
    ["missing App key", { "999": { success: false } }],
    ["null data", { "620": { success: true, data: null } }],
    ["empty object", { "620": { success: true, data: {} } }],
    ["empty array", { "620": { success: true, data: [] } }],
  ];

  for (const [label, body] of unavailable) {
    it(`keeps last-known-good Metadata and records unavailable for ${label}`, async () => {
      const db = database();
      seedGame(db, 620);
      seedStorefront(db, 620);
      const { source: storefront } = source(json(body));

      expect(await fetchStorefront(db, storefront)).toEqual({ kind: "unavailable" });

      expect(row(db, 620)).toMatchObject({
        type: "game",
        developers_json: '["Valve"]',
        genres_json: '["Action"]',
        metacritic_score: 95,
        release_date_raw: "Apr 18, 2011",
        release_year: 2011,
        store_status: "unavailable",
        store_fetched_at: NOW,
        store_error: null,
        raw_store_json: '{"cached":true}',
      });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM games").get()).toEqual({ count: 1 });
    });
  }

  it("creates an unavailable row for a Game with no previous storefront data", async () => {
    const db = database();
    seedGame(db, 620);
    const { source: storefront } = source(json({ "620": { success: false } }));

    expect(await fetchStorefront(db, storefront)).toEqual({ kind: "unavailable" });
    expect(row(db, 620)).toMatchObject({
      type: null,
      developers_json: "[]",
      store_status: "unavailable",
      store_fetched_at: NOW,
      store_error: null,
      raw_store_json: null,
    });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM games").get()).toEqual({ count: 1 });
  });
});

describe("StorefrontSource malformed and failed responses", () => {
  it("stores nothing on malformed JSON and keeps last-known-good as stale", async () => {
    const db = database();
    seedGame(db, 620);
    seedStorefront(db, 620);
    const { source: storefront } = source(
      new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
    );

    const outcome = await fetchStorefront(db, storefront);
    expect(outcome).toMatchObject({ kind: "error" });
    expect(row(db, 620)).toMatchObject({
      type: "game",
      developers_json: '["Valve"]',
      store_status: "stale",
      store_fetched_at: NOW - 100,
      raw_store_json: '{"cached":true}',
    });
    expect(String(row(db, 620)!.store_error)).toMatch(/malformed/i);
  });

  it("stores nothing on an explicit steam_appid mismatch and records error without data", async () => {
    const db = database();
    seedGame(db, 620);
    const { source: storefront } = source(
      json({ "620": { success: true, data: fullPayload({ steam_appid: 999 }) } }),
    );

    const outcome = await fetchStorefront(db, storefront, 620);
    expect(outcome).toMatchObject({ kind: "error" });
    expect(row(db, 620)).toMatchObject({
      type: null,
      developers_json: "[]",
      store_status: "error",
      store_fetched_at: null,
      raw_store_json: null,
    });
    expect(String(row(db, 620)!.store_error)).toMatch(/620/);
    expect(String(row(db, 620)!.store_error)).toMatch(/999/);
    expect(db.raw.prepare("SELECT name FROM games").get()).toEqual({ name: "Game 620" });
  });

  it("keeps last-known-good data and writes only both IDs on a mismatch", async () => {
    const db = database();
    seedGame(db, 620);
    seedStorefront(db, 620);
    const { source: storefront } = source(
      json({ "620": { success: true, data: fullPayload({ steam_appid: 999 }) } }),
    );

    const outcome = await fetchStorefront(db, storefront, 620);
    expect(outcome).toMatchObject({ kind: "error" });
    const stored = row(db, 620)!;
    expect(stored).toMatchObject({
      type: "game",
      developers_json: '["Valve"]',
      metacritic_score: 95,
      store_status: "stale",
      store_fetched_at: NOW - 100,
      raw_store_json: '{"cached":true}',
    });

    // The diagnostic names both App IDs and never leaks the payload.
    expect(String(stored.store_error)).toContain("620");
    expect(String(stored.store_error)).toContain("999");
    expect(String(stored.store_error)).not.toContain("Portal 2");
    expect(String(stored.store_error)).not.toContain("Valve");
    expect(db.raw.prepare("SELECT name FROM games").get()).toEqual({ name: "Game 620" });
  });

  it("treats a different numeric-string steam_appid as a mismatch", async () => {
    const db = database();
    seedGame(db, 620);
    const { source: storefront } = source(
      json({ "620": { success: true, data: fullPayload({ steam_appid: "999" }) } }),
    );

    const outcome = await fetchStorefront(db, storefront, 620);
    expect(outcome).toMatchObject({ kind: "error" });
    expect(String(row(db, 620)!.store_error)).toContain("999");
  });

  it("does not retry a 400 and records the failure", async () => {
    const db = database();
    seedGame(db, 620);
    seedStorefront(db, 620);
    const { source: storefront, requests } = source(new Response("null", { status: 400 }));

    const outcome = await fetchStorefront(db, storefront);
    expect(outcome).toEqual({
      kind: "error",
      message: "The storefront rejected the request shape.",
      retryable: false,
    });
    expect(requests).toHaveLength(1);
    expect(row(db, 620)).toMatchObject({
      store_status: "stale",
      store_fetched_at: NOW - 100,
      metacritic_score: 95,
    });
    expect(String(row(db, 620)!.store_error)).toMatch(/request shape/i);
  });

  it("maps 429 Retry-After to rate_limited and keeps cached data", async () => {
    const db = database();
    seedGame(db, 620);
    seedStorefront(db, 620);
    const { source: storefront } = source(
      new Response("", { status: 429, headers: { "retry-after": "120" } }),
    );

    expect(await fetchStorefront(db, storefront)).toEqual({
      kind: "rate_limited",
      retryAfterAt: NOW + 120,
      message: "The storefront rate limited the request.",
    });
    expect(row(db, 620)).toMatchObject({
      store_status: "stale",
      metacritic_score: 95,
      store_fetched_at: NOW - 100,
    });
  });

  it("maps a 429 without Retry-After to a null retry time", async () => {
    const db = database();
    seedGame(db, 620);
    const { source: storefront } = source(new Response("", { status: 429 }));

    expect(await fetchStorefront(db, storefront)).toEqual({
      kind: "rate_limited",
      retryAfterAt: null,
      message: "The storefront rate limited the request.",
    });
  });

  it("treats an HTML 200 body as malformed JSON without parsing it", async () => {
    const db = database();
    seedGame(db, 620);
    seedStorefront(db, 620);
    const { source: storefront } = source(
      new Response("<html>block challenge</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    expect(await fetchStorefront(db, storefront)).toMatchObject({ kind: "error" });
    expect(row(db, 620)).toMatchObject({
      store_status: "stale",
      metacritic_score: 95,
      raw_store_json: '{"cached":true}',
    });
    expect(String(row(db, 620)!.store_error)).toMatch(/malformed JSON/i);
  });

  it("maps 403 to blocked, 5xx to a retryable error, and a timeout/network failure to error", async () => {
    const cases: Array<{
      label: string;
      response: Response | (() => Response);
      kind: string;
      retryable?: boolean;
    }> = [
      { label: "403", response: new Response("", { status: 403 }), kind: "blocked" },
      {
        label: "503",
        response: new Response("", { status: 503 }),
        kind: "error",
        retryable: true,
      },
      {
        label: "timeout",
        response: () => {
          throw new DOMException("The operation timed out.", "TimeoutError");
        },
        kind: "error",
      },
    ];

    for (const entry of cases) {
      const db = database();
      seedGame(db, 620);
      seedStorefront(db, 620);
      const { source: storefront } = source(entry.response);

      const outcome = await fetchStorefront(db, storefront);
      expect(outcome.kind, entry.label).toBe(entry.kind);
      if (entry.retryable !== undefined) {
        expect((outcome as { retryable?: boolean }).retryable).toBe(entry.retryable);
      }
      expect(row(db, 620)).toMatchObject({
        store_status: "stale",
        metacritic_score: 95,
        store_fetched_at: NOW - 100,
      });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM games").get()).toEqual({ count: 1 });
    }
  });
});

describe("release year parsing", () => {
  const cases: Array<[string | null, number | null]> = [
    ["Apr 18, 2011", 2011],
    ["18 Apr, 2011", 2011],
    ["2014", 2014],
    ["Released 2011-04-18", 2011],
    ["Coming soon", null],
    ["TBA", null],
    ["Spring", null],
    ["", null],
    [null, null],
  ];

  for (const [raw, expected] of cases) {
    it(`parses ${JSON.stringify(raw)} as ${String(expected)}`, () => {
      expect(parseReleaseYear(raw)).toBe(expected);
    });
  }

  it("keeps an unparseable raw release string with a null year", async () => {
    const db = database();
    seedGame(db, 620);
    const { source: storefront } = source(
      json(payload(620, fullPayload({ release_date: { coming_soon: true, date: "Coming soon" } }))),
    );

    expect(await fetchStorefront(db, storefront)).toEqual({ kind: "ok" });
    expect(row(db, 620)).toMatchObject({
      release_date_raw: "Coming soon",
      release_year: null,
    });
  });
});

describe("name precedence and cross-source safety", () => {
  it("does not let a later local scan overwrite a storefront name", async () => {
    const db = database();
    const steam = fixture();
    steam.writeManifest(steam.root, 620, { name: "Local Stale Name" });
    seedGame(db, 620, { name: "Portal 2", nameSource: "storefront" });

    const result = scanLocalLibrary({
      db: db.raw,
      steamRoot: steam.root,
      steamId64: TEST_STEAM_ID64,
      now: () => NOW,
    });
    expect(result.stats.upserted).toBe(1);
    expect(db.raw.prepare("SELECT name, name_key, name_source FROM games").get()).toEqual({
      name: "Portal 2",
      name_key: "portal 2",
      name_source: "storefront",
    });
  });

  it("never removes Tags, reviews, or the Game when the storefront fails", async () => {
    const db = database();
    seedGame(db, 1);
    db.raw
      .prepare(
        `INSERT INTO steamspy_appdetails (app_id, tags_status, tags_fetched_at, updated_at)
         VALUES (1, 'ok', ?, ?)`,
      )
      .run(NOW - 10, NOW - 10);
    db.raw.prepare("INSERT INTO tags (id, name, name_key) VALUES (7, 'Puzzle', 'puzzle')").run();
    db.raw.prepare("INSERT INTO game_tags (app_id, tag_id, votes) VALUES (1, 7, 42)").run();
    db.raw
      .prepare(
        `INSERT INTO steam_review_summaries (
           app_id, review_positive, review_negative, review_total, review_tier,
           review_status, review_fetched_at, updated_at
         ) VALUES (1, 8, 2, 10, 'Very Positive', 'ok', ?, ?)`,
      )
      .run(NOW - 10, NOW - 10);

    const { source: failing } = source(new Response("nope", { status: 503 }));
    expect(await fetchStorefront(db, failing, 1)).toMatchObject({ kind: "error" });

    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM games").get()).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM steamspy_appdetails").get()).toEqual({
      count: 1,
    });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM game_tags").get()).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM steam_review_summaries").get()).toEqual({
      count: 1,
    });
  });
});

describe("Refresh engine integration", () => {
  it("does not retry a non-retryable 400 and finishes partial", async () => {
    const db = database();
    seedGame(db, 620);
    let calls = 0;
    const now = { seconds: NOW };
    const storefront = new StorefrontSource({
      fetch: async () => {
        calls += 1;
        return new Response("null", { status: 400 });
      },
    });
    const refresh = new RefreshService({
      db: db.raw,
      steamRoot: null,
      steamId64: null,
      now: () => now.seconds,
      jitter: () => 0,
      sleep: async (milliseconds) => {
        now.seconds += milliseconds / 1_000;
      },
      sources: [storefront],
    });

    const started = await refresh.start({ scope: "metadata", mode: "full", appIds: [620] });
    await refresh.waitForIdle();
    const run = readRefreshRun(db.raw, Number(started.run.id))!;

    expect(calls).toBe(1);
    expect(run.status).toBe("partial");
    expect(run.stats?.sources.storefront).toEqual({
      candidates: 1,
      done: 0,
      failed: 1,
      skipped: 0,
    });
    expect(
      db.raw
        .prepare("SELECT status, retry_after_at FROM source_state WHERE name = 'storefront'")
        .get(),
    ).toEqual({ status: "error", retry_after_at: null });
    expect(row(db, 620)).toMatchObject({ store_status: "error", store_error: expect.any(String) });
  });
});
