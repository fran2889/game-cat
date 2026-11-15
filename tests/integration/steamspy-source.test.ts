import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../../src/server/db/database.ts";
import { RefreshService } from "../../src/server/refresh/service.ts";
import type { MetadataSourceOutcome } from "../../src/server/refresh/sources.ts";
import {
  createSteamSpySource,
  STEAMSPY_USER_AGENT,
  type SteamSpySourceOptions,
} from "../../src/server/steam/steamspy.ts";
import { normalizeNameKey } from "../../src/shared/names.ts";

const NOW = 1_700_000_000;
const dataDirs: string[] = [];
const databases: AppDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (dataDirs.length > 0) {
    rmSync(dataDirs.pop()!, { recursive: true, force: true });
  }
});

function openDatabase(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-steamspy-"));
  dataDirs.push(dir);
  const db = openAppDatabase({ dataDir: dir, steamWebApiConfigured: false });
  databases.push(db);
  return db;
}

function seedGame(
  db: AppDatabase,
  appId: number,
  name = `Game ${appId}`,
  nameSource = "placeholder",
): void {
  db.raw
    .prepare(
      `INSERT INTO games (
         app_id, name, name_key, name_source, ownership_status,
         playtime_minutes, source_mask, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, 'owned', 0, 1, 1, 1)`,
    )
    .run(appId, name, normalizeNameKey(name), nameSource);
}

function seedTags(db: AppDatabase, appId: number, tags: Record<string, number>): void {
  const insertTag = db.raw.prepare("INSERT OR IGNORE INTO tags (name, name_key) VALUES (?, ?)");
  const selectTag = db.raw.prepare("SELECT id FROM tags WHERE name_key = ?");
  const insertGameTag = db.raw.prepare(
    "INSERT OR REPLACE INTO game_tags (app_id, tag_id, votes) VALUES (?, ?, ?)",
  );
  db.raw
    .prepare(
      `INSERT INTO steamspy_appdetails (app_id, tags_status, tags_fetched_at, updated_at)
       VALUES (?, 'ok', 1, 1)
       ON CONFLICT(app_id) DO UPDATE SET tags_status = 'ok', tags_fetched_at = 1`,
    )
    .run(appId);
  for (const [name, votes] of Object.entries(tags)) {
    insertTag.run(name, normalizeNameKey(name));
    const row = selectTag.get(normalizeNameKey(name)) as { id: number };
    insertGameTag.run(appId, row.id, votes);
  }
}

interface FakeResponse {
  status?: number;
  body?: unknown;
  json?: string;
  headers?: Record<string, string>;
  throws?: "network" | "timeout";
}

interface FetchCall {
  url: string;
  userAgent: string | null;
}

function fakeFetch(handler: (url: string) => FakeResponse | Promise<FakeResponse>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, userAgent: new Headers(init?.headers).get("user-agent") });
    const spec = await handler(url);
    if (spec.throws === "network") {
      throw new TypeError("fetch failed");
    }
    if (spec.throws === "timeout") {
      await new Promise<never>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          reject(new Error("missing abort signal"));
          return;
        }
        if (signal.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }
    return new Response(spec.json ?? JSON.stringify(spec.body ?? {}), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json", ...spec.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function source(fetchImpl: typeof fetch, options: Partial<SteamSpySourceOptions> = {}) {
  return createSteamSpySource({ fetchImpl, timeoutMs: 50, ...options });
}

async function fetchGame(
  db: AppDatabase,
  adapter: ReturnType<typeof source>,
  appId: number,
): Promise<MetadataSourceOutcome> {
  return adapter.fetch({ db: db.raw, game: { appId, name: `Game ${appId}` }, now: NOW });
}

function tagsFor(db: AppDatabase, appId: number): Array<{ name: string; votes: number }> {
  return db.raw
    .prepare(
      `SELECT t.name AS name, gt.votes AS votes
       FROM game_tags gt JOIN tags t ON t.id = gt.tag_id
       WHERE gt.app_id = ? ORDER BY gt.votes DESC, t.name ASC`,
    )
    .all(appId) as Array<{ name: string; votes: number }>;
}

function steamspyRow(db: AppDatabase, appId: number) {
  return db.raw.prepare("SELECT * FROM steamspy_appdetails WHERE app_id = ?").get(appId) as
    | {
        steamspy_name: string | null;
        tags_status: string;
        tags_fetched_at: number | null;
        tags_error: string | null;
        raw_steamspy_json: string | null;
        updated_at: number;
      }
    | undefined;
}

const populated = {
  appid: 730,
  name: "Counter-Strike: Global Offensive",
  developer: "Valve",
  publisher: "Valve",
  userscore: 85,
  owners: "200,000,000 .. 500,000,000",
  tags: { FPS: 92858, Shooter: 66748, Multiplayer: 63661 },
};

const zeroed = {
  appid: 999999999,
  name: null,
  developer: "",
  publisher: "",
  positive: 0,
  negative: 0,
  userscore: 0,
  owners: "0 .. 20,000",
  price: null,
  ccu: 0,
  languages: null,
  genre: null,
  tags: [],
};

describe("SteamSpySource request", () => {
  it("requests one App with the documented endpoint and descriptive User-Agent", async () => {
    const db = openDatabase();
    seedGame(db, 730);
    const fake = fakeFetch(() => ({ body: populated }));
    const adapter = source(fake.fetchImpl);

    const outcome = await fetchGame(db, adapter, 730);

    expect(outcome).toEqual({ kind: "ok" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe("https://steamspy.com/api.php?request=appdetails&appid=730");
    expect(fake.calls[0]?.userAgent).toBe(STEAMSPY_USER_AGENT);
    expect(STEAMSPY_USER_AGENT).toMatch(/^game-cat\/\S+ \(local Steam library app\)$/);
  });
});

describe("SteamSpySource populated response", () => {
  it("stores Tags with votes, status, timestamp, name, and raw payload atomically", async () => {
    const db = openDatabase();
    seedGame(db, 730, "Game 730", "placeholder");
    const fake = fakeFetch(() => ({ body: populated }));
    const adapter = source(fake.fetchImpl);

    expect(await fetchGame(db, adapter, 730)).toEqual({ kind: "ok" });

    expect(tagsFor(db, 730)).toEqual([
      { name: "FPS", votes: 92858 },
      { name: "Shooter", votes: 66748 },
      { name: "Multiplayer", votes: 63661 },
    ]);
    const row = steamspyRow(db, 730);
    expect(row).toMatchObject({
      steamspy_name: "Counter-Strike: Global Offensive",
      tags_status: "ok",
      tags_fetched_at: NOW,
      tags_error: null,
      updated_at: NOW,
    });
    expect(JSON.parse(row?.raw_steamspy_json ?? "null")).toEqual(populated);
    expect(db.raw.prepare("SELECT name, name_source FROM games WHERE app_id = 730").get()).toEqual({
      name: "Counter-Strike: Global Offensive",
      name_source: "steamspy",
    });
  });

  it("replaces game_tags atomically and never duplicates a normalized Tag", async () => {
    const db = openDatabase();
    seedGame(db, 1);
    seedGame(db, 2);
    const responses: Record<number, FakeResponse> = {
      1: { body: { appid: 1, name: "Game One", tags: { Roguelike: 5, Indie: 9 } } },
      2: { body: { appid: 2, name: "Game Two", tags: { roguelike: 7 } } },
    };
    const fake = fakeFetch((url) => {
      const appId = Number(new URL(url).searchParams.get("appid"));
      return responses[appId] ?? { body: zeroed };
    });
    const adapter = source(fake.fetchImpl);

    await fetchGame(db, adapter, 1);
    await fetchGame(db, adapter, 2);

    expect(db.raw.prepare("SELECT id, name, name_key FROM tags ORDER BY id").all()).toEqual([
      { id: 1, name: "Roguelike", name_key: "roguelike" },
      { id: 2, name: "Indie", name_key: "indie" },
    ]);
    expect(tagsFor(db, 1)).toEqual([
      { name: "Indie", votes: 9 },
      { name: "Roguelike", votes: 5 },
    ]);
    expect(tagsFor(db, 2)).toEqual([{ name: "Roguelike", votes: 7 }]);

    // A later response replaces the Game's Tag set (removing Indie) and
    // updates votes, without disturbing the vocabulary row.
    responses[1] = { body: { appid: 1, name: "Game One", tags: { Roguelike: 20 } } };
    await fetchGame(db, adapter, 1);
    expect(tagsFor(db, 1)).toEqual([{ name: "Roguelike", votes: 20 }]);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM tags").get()).toEqual({ count: 2 });
  });

  it("applies the name matrix and keeps a local name", async () => {
    const db = openDatabase();
    seedGame(db, 1, "Local Name", "local");
    seedGame(db, 2, "Old Spy Name", "steamspy");
    const fake = fakeFetch((url) => {
      const appId = Number(new URL(url).searchParams.get("appid"));
      return { body: { appid: appId, name: `Spy ${appId}`, tags: { Action: 1 } } };
    });
    const adapter = source(fake.fetchImpl);

    await fetchGame(db, adapter, 1);
    await fetchGame(db, adapter, 2);

    expect(db.raw.prepare("SELECT name, name_source FROM games WHERE app_id = 1").get()).toEqual({
      name: "Local Name",
      name_source: "local",
    });
    expect(db.raw.prepare("SELECT name, name_source FROM games WHERE app_id = 2").get()).toEqual({
      name: "Spy 2",
      name_source: "steamspy",
    });
  });
});

describe("SteamSpySource settled miss", () => {
  it("stores no Tags and records a settled missing for a zeroed record", async () => {
    const db = openDatabase();
    seedGame(db, 999999999);
    seedTags(db, 999999999, { Puzzle: 10 });
    const fake = fakeFetch(() => ({ body: zeroed }));
    const adapter = source(fake.fetchImpl);

    expect(await fetchGame(db, adapter, 999999999)).toEqual({ kind: "missing" });

    expect(tagsFor(db, 999999999)).toEqual([]);
    expect(steamspyRow(db, 999999999)).toMatchObject({
      tags_status: "missing",
      tags_fetched_at: NOW,
      tags_error: null,
      updated_at: NOW,
    });
  });

  it("records missing for an empty Tags object and stores a present SteamSpy name", async () => {
    const db = openDatabase();
    seedGame(db, 42, "Game 42", "placeholder");
    const fake = fakeFetch(() => ({
      body: { appid: 42, name: "Spy Forty-Two", tags: {} },
    }));
    const adapter = source(fake.fetchImpl);

    expect(await fetchGame(db, adapter, 42)).toEqual({ kind: "missing" });
    expect(tagsFor(db, 42)).toEqual([]);
    expect(steamspyRow(db, 42)).toMatchObject({
      steamspy_name: "Spy Forty-Two",
      tags_status: "missing",
      tags_fetched_at: NOW,
    });
    expect(db.raw.prepare("SELECT name, name_source FROM games WHERE app_id = 42").get()).toEqual({
      name: "Spy Forty-Two",
      name_source: "steamspy",
    });
  });

  it("accepts absent Tags as empty and refuses a null name", async () => {
    const db = openDatabase();
    seedGame(db, 1);
    seedGame(db, 2);
    const fake = fakeFetch((url) => {
      const appId = Number(new URL(url).searchParams.get("appid"));
      return appId === 1
        ? { body: { appid: 1, name: "One" } }
        : { body: { appid: 2, name: null, tags: { Action: 1 } } };
    });
    const adapter = source(fake.fetchImpl);

    expect(await fetchGame(db, adapter, 1)).toEqual({ kind: "missing" });
    expect(await fetchGame(db, adapter, 2)).toEqual({
      kind: "error",
      message: expect.any(String),
    });
    expect(tagsFor(db, 2)).toEqual([]);
    expect(steamspyRow(db, 2)?.tags_status).toBe("error");
  });
});

describe("SteamSpySource failures keep last-known-good Tags", () => {
  it("keeps Tags on an appid mismatch and records stale with no raw overwrite", async () => {
    const db = openDatabase();
    seedGame(db, 730);
    seedTags(db, 730, { Puzzle: 10 });
    db.raw
      .prepare(
        `INSERT INTO storefront_appdetails (app_id, metacritic_score, store_status, updated_at)
         VALUES (730, 95, 'ok', 1)`,
      )
      .run();
    const fake = fakeFetch(() => ({
      body: { appid: 999, name: "Other Game", tags: { Horror: 3 } },
    }));
    const adapter = source(fake.fetchImpl);

    expect(await fetchGame(db, adapter, 730)).toEqual({
      kind: "error",
      message: expect.any(String),
    });

    expect(tagsFor(db, 730)).toEqual([{ name: "Puzzle", votes: 10 }]);
    const row = steamspyRow(db, 730);
    expect(row?.tags_status).toBe("stale");
    expect(row?.tags_error).toBeTruthy();
    expect(row?.tags_fetched_at).toBe(1);
    expect(row?.steamspy_name).toBeNull();
    expect(row?.raw_steamspy_json).toBeNull();
    expect(
      db.raw.prepare("SELECT metacritic_score FROM storefront_appdetails WHERE app_id = 730").get(),
    ).toEqual({ metacritic_score: 95 });
  });

  it("records error when a mismatch has no last-known-good Tags", async () => {
    const db = openDatabase();
    seedGame(db, 730);
    const fake = fakeFetch(() => ({ body: { appid: 1, name: "Other", tags: { A: 1 } } }));
    const adapter = source(fake.fetchImpl);

    expect((await fetchGame(db, adapter, 730)).kind).toBe("error");
    expect(steamspyRow(db, 730)?.tags_status).toBe("error");
  });

  it("keeps Tags on malformed JSON", async () => {
    const db = openDatabase();
    seedGame(db, 620);
    seedTags(db, 620, { Puzzle: 10 });
    const fake = fakeFetch(() => ({ json: "{not-json" }));
    const adapter = source(fake.fetchImpl);

    expect((await fetchGame(db, adapter, 620)).kind).toBe("error");
    expect(tagsFor(db, 620)).toEqual([{ name: "Puzzle", votes: 10 }]);
    expect(steamspyRow(db, 620)).toMatchObject({ tags_status: "stale", tags_fetched_at: 1 });
  });

  it("keeps Tags on a null name and does not store the payload", async () => {
    const db = openDatabase();
    seedGame(db, 620);
    seedTags(db, 620, { Puzzle: 10 });
    const fake = fakeFetch(() => ({
      body: { appid: 620, name: null, tags: { Horror: 3 } },
    }));
    const adapter = source(fake.fetchImpl);

    expect((await fetchGame(db, adapter, 620)).kind).toBe("error");
    expect(tagsFor(db, 620)).toEqual([{ name: "Puzzle", votes: 10 }]);
    expect(steamspyRow(db, 620)?.tags_status).toBe("stale");
  });

  it("maps 429 to rate_limited with Retry-After and keeps Tags", async () => {
    const db = openDatabase();
    seedGame(db, 620);
    seedTags(db, 620, { Puzzle: 10 });
    const fake = fakeFetch(() => ({
      status: 429,
      headers: { "retry-after": "120" },
      body: { error: "slow down" },
    }));
    const adapter = source(fake.fetchImpl);

    expect(await fetchGame(db, adapter, 620)).toEqual({
      kind: "rate_limited",
      retryAfterAt: NOW + 120,
      message: expect.any(String),
    });
    expect(tagsFor(db, 620)).toEqual([{ name: "Puzzle", votes: 10 }]);
    expect(steamspyRow(db, 620)?.tags_status).toBe("stale");
  });

  it("maps 403 and a challenge header to blocked and keeps Tags", async () => {
    const db = openDatabase();
    seedGame(db, 620);
    seedTags(db, 620, { Puzzle: 10 });
    const fake = fakeFetch(() => ({ status: 403, json: "<html>challenge</html>" }));
    const adapter = source(fake.fetchImpl);

    expect(await fetchGame(db, adapter, 620)).toEqual({
      kind: "blocked",
      message: expect.any(String),
    });
    expect(tagsFor(db, 620)).toEqual([{ name: "Puzzle", votes: 10 }]);
    expect(steamspyRow(db, 620)?.tags_status).toBe("stale");

    const challenged = fakeFetch(() => ({
      status: 200,
      headers: { "cf-mitigated": "challenge" },
      json: "<html>challenge</html>",
    }));
    expect((await fetchGame(db, source(challenged.fetchImpl), 620)).kind).toBe("blocked");
  });

  it("maps 5xx, timeouts, and network errors to error and keeps Tags", async () => {
    for (const failure of [
      { status: 503, json: "unavailable" },
      { throws: "timeout" as const },
      { throws: "network" as const },
    ]) {
      const db = openDatabase();
      seedGame(db, 620);
      seedTags(db, 620, { Puzzle: 10 });
      const fake = fakeFetch(() => failure);
      const adapter = source(fake.fetchImpl, { timeoutMs: 5 });

      const outcome = await fetchGame(db, adapter, 620);
      expect(outcome.kind).toBe("error");
      expect(tagsFor(db, 620)).toEqual([{ name: "Puzzle", votes: 10 }]);
      expect(steamspyRow(db, 620)?.tags_status).toBe("stale");
    }
  });

  it("records an error row on a failure before any successful fetch", async () => {
    const db = openDatabase();
    seedGame(db, 620);
    const fake = fakeFetch(() => ({ status: 500, json: "nope" }));
    const adapter = source(fake.fetchImpl);

    expect((await fetchGame(db, adapter, 620)).kind).toBe("error");
    expect(steamspyRow(db, 620)).toMatchObject({
      tags_status: "error",
      tags_fetched_at: null,
      updated_at: NOW,
    });
  });
});

describe("SteamSpy settled miss and Fetch selection", () => {
  it("a second metadata Fetch makes no SteamSpy request for a settled miss", async () => {
    const db = openDatabase();
    seedGame(db, 999999999);
    const fake = fakeFetch(() => ({ body: { ...zeroed, appid: 999999999 } }));
    const adapter = source(fake.fetchImpl);
    const refresh = new RefreshService({
      db: db.raw,
      steamRoot: null,
      steamId64: null,
      steamApiKey: null,
      sources: [adapter],
      now: () => NOW,
    });

    await refresh.start({ scope: "metadata", mode: "fetch" });
    await refresh.waitForIdle();
    expect(fake.calls).toHaveLength(1);
    expect(steamspyRow(db, 999999999)?.tags_status).toBe("missing");
    expect(steamspyRow(db, 999999999)?.tags_fetched_at).toBe(NOW);

    const second = await refresh.start({ scope: "metadata", mode: "fetch" });
    await refresh.waitForIdle();
    expect(fake.calls).toHaveLength(1);
    expect(refresh.get(Number(second.run.id))?.total).toBe(0);
  });
});
