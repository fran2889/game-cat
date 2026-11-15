import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabase } from "../../src/server/db/database.ts";
import { GamesRepository } from "../../src/server/library/games.ts";
import {
  REVIEWS_USER_AGENT,
  SteamReviewSource,
  type SteamReviewSourceOptions,
} from "../../src/server/refresh/reviews.ts";
import type { MetadataSourceContext } from "../../src/server/refresh/sources.ts";

const NOW = 1_700_000_000;
const APP_ID = 620;

const dirs: string[] = [];
const databases: AppDatabase[] = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

interface Harness {
  db: AppDatabase;
  context: MetadataSourceContext;
}

function harness(appId = APP_ID): Harness {
  const dir = mkdtempSync(join(tmpdir(), "game-cat-reviews-"));
  dirs.push(dir);
  const db = openAppDatabase({ dataDir: dir, steamWebApiConfigured: false });
  databases.push(db);
  db.raw
    .prepare(
      `INSERT INTO games (
         app_id, name, name_key, name_source, ownership_status,
         playtime_minutes, source_mask, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, 'placeholder', 'owned', 0, 1, 1, 1)`,
    )
    .run(appId, `Game ${appId}`, `game ${appId}`);
  return {
    db,
    context: { db: db.raw, game: { appId, name: `Game ${appId}` }, now: NOW },
  };
}

interface ReviewRow {
  review_positive: number | null;
  review_negative: number | null;
  review_total: number | null;
  review_tier: string | null;
  review_status: string;
  review_fetched_at: number | null;
  review_error: string | null;
  raw_reviews_json: string | null;
}

function reviewRow(db: AppDatabase, appId = APP_ID): ReviewRow | undefined {
  return db.raw.prepare("SELECT * FROM steam_review_summaries WHERE app_id = ?").get(appId) as
    ReviewRow | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

type FakeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function source(fetchImpl: FakeFetch, options: SteamReviewSourceOptions = {}): SteamReviewSource {
  return new SteamReviewSource({ ...options, fetchImpl: fetchImpl as typeof fetch });
}

const SUMMARY = {
  success: 1,
  query_summary: {
    num_reviews: 0,
    review_score: 9,
    review_score_desc: "Overwhelmingly Positive",
    total_positive: 4900,
    total_negative: 100,
    total_reviews: 5000,
  },
  reviews: [],
};

describe("SteamReviewSource request contract", () => {
  it("requests the documented appreviews URL once with a descriptive User-Agent", async () => {
    const test = harness();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const reviews = source(async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(SUMMARY);
    });

    const outcome = await reviews.fetch(test.context);

    expect(outcome).toEqual({ kind: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://store.steampowered.com/appreviews/620?json=1&language=all&purchase_type=all&num_per_page=0&l=english",
    );
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect((calls[0]?.init?.headers as Record<string, string>)["user-agent"]).toBe(
      REVIEWS_USER_AGENT,
    );
    expect(REVIEWS_USER_AGENT).toBe("game-cat/0.1.0 (local Steam library app)");
    expect(reviews.name).toBe("steam_reviews");
    expect(reviews.hostKey).toBe("store");
  });
});

describe("SteamReviewSource successful summaries", () => {
  it("stores counts, the exact tier, status ok, timestamp, and raw JSON", async () => {
    const test = harness();
    const reviews = source(async () => jsonResponse(SUMMARY));

    expect(await reviews.fetch(test.context)).toEqual({ kind: "ok" });

    const row = reviewRow(test.db);
    expect(row).toMatchObject({
      review_positive: 4900,
      review_negative: 100,
      review_total: 5000,
      review_tier: "Overwhelmingly Positive",
      review_status: "ok",
      review_fetched_at: NOW,
      review_error: null,
    });
    expect(JSON.parse(row?.raw_reviews_json ?? "null")).toEqual(SUMMARY);

    const game = new GamesRepository(test.db.raw).get(APP_ID);
    expect(game).toMatchObject({
      reviewScore: 98,
      reviewTier: "Overwhelmingly Positive",
      reviewCount: 5000,
      metadata: { reviewStatus: "ok", reviewFetchedAt: "2023-11-14T22:13:20Z" },
    });
  });

  it("rounds the computed score half away from zero", async () => {
    const test = harness(1);
    test.db.raw
      .prepare(
        `INSERT INTO games (app_id, name, name_key, name_source, ownership_status,
           playtime_minutes, source_mask, first_seen_at, last_seen_at)
         VALUES (8, 'Game 8', 'game 8', 'placeholder', 'owned', 0, 1, 1, 1),
                (9, 'Game 9', 'game 9', 'placeholder', 'owned', 0, 1, 1, 1)`,
      )
      .run();

    const responses = new Map<number, unknown>([
      [
        1,
        {
          success: 1,
          query_summary: {
            total_positive: 1,
            total_negative: 7,
            total_reviews: 8,
            review_score_desc: "Mixed",
          },
        },
      ],
      [
        8,
        {
          success: 1,
          query_summary: {
            total_positive: 3,
            total_negative: 5,
            total_reviews: 8,
            review_score_desc: "Mixed",
          },
        },
      ],
      [
        9,
        {
          success: 1,
          query_summary: {
            total_positive: 0,
            total_negative: 10,
            total_reviews: 10,
            review_score_desc: "Very Negative",
          },
        },
      ],
    ]);
    const reviews = source(async (input) => {
      const appId = Number(new URL(String(input)).pathname.split("/").at(-1));
      return jsonResponse(responses.get(appId));
    });

    await reviews.fetch(test.context);
    await reviews.fetch({
      ...test.context,
      game: { appId: 8, name: "Game 8" },
    });
    await reviews.fetch({
      ...test.context,
      game: { appId: 9, name: "Game 9" },
    });

    const repository = new GamesRepository(test.db.raw);
    expect(repository.get(1)?.reviewScore).toBe(13);
    expect(repository.get(8)?.reviewScore).toBe(38);
    expect(repository.get(9)?.reviewScore).toBe(0);
    expect(repository.get(9)?.reviewTier).toBe("Very Negative");
  });

  it("stores a known zero with no tier and computes no score", async () => {
    const test = harness();
    const body = {
      success: 1,
      query_summary: {
        num_reviews: 0,
        review_score: 0,
        review_score_desc: "No user reviews",
        total_positive: 0,
        total_negative: 0,
        total_reviews: 0,
      },
      reviews: [],
    };
    const reviews = source(async () => jsonResponse(body));

    expect(await reviews.fetch(test.context)).toEqual({ kind: "unavailable" });

    expect(reviewRow(test.db)).toMatchObject({
      review_positive: 0,
      review_negative: 0,
      review_total: 0,
      review_tier: null,
      review_status: "unavailable",
      review_fetched_at: NOW,
      review_error: null,
    });
    expect(new GamesRepository(test.db.raw).get(APP_ID)).toMatchObject({
      reviewScore: null,
      reviewTier: null,
      reviewCount: 0,
      metadata: { reviewStatus: "unavailable" },
    });
  });
});

describe("SteamReviewSource empty responses", () => {
  function seedOk(test: Harness, fetchedAt = NOW - 60): void {
    test.db.raw
      .prepare(
        `INSERT INTO steam_review_summaries (
           app_id, review_positive, review_negative, review_total, review_tier,
           review_status, review_fetched_at, updated_at
         ) VALUES (?, 4900, 100, 5000, 'Overwhelmingly Positive', 'ok', ?, ?)`,
      )
      .run(APP_ID, fetchedAt, fetchedAt);
  }

  it("keeps last-known-good values as stale when success is 0", async () => {
    const test = harness();
    seedOk(test);
    const reviews = source(async () => jsonResponse({ success: 0, reviews: [] }));

    expect(await reviews.fetch(test.context)).toEqual({ kind: "unavailable" });
    expect(reviewRow(test.db)).toMatchObject({
      review_positive: 4900,
      review_negative: 100,
      review_total: 5000,
      review_tier: "Overwhelmingly Positive",
      review_status: "stale",
      review_fetched_at: NOW - 60,
    });
    expect(reviewRow(test.db)?.review_error).toMatch(/no usable review summary/i);
    expect(JSON.parse(reviewRow(test.db)?.raw_reviews_json ?? "null")).toEqual({
      success: 0,
      reviews: [],
    });
  });

  it("clears values as unavailable when success is 0 and nothing is cached", async () => {
    const test = harness();
    const reviews = source(async () => jsonResponse({ success: 0 }));

    expect(await reviews.fetch(test.context)).toEqual({ kind: "unavailable" });
    expect(reviewRow(test.db)).toMatchObject({
      review_positive: null,
      review_negative: null,
      review_total: null,
      review_tier: null,
      review_status: "unavailable",
      review_fetched_at: NOW,
    });
    expect(new GamesRepository(test.db.raw).get(APP_ID)).toMatchObject({
      reviewScore: null,
      reviewTier: null,
      reviewCount: null,
      metadata: { reviewStatus: "unavailable" },
    });
  });

  it("treats a missing query_summary the same as success 0", async () => {
    const test = harness();
    const reviews = source(async () => jsonResponse({ success: 1 }));

    expect(await reviews.fetch(test.context)).toEqual({ kind: "unavailable" });
    expect(reviewRow(test.db)).toMatchObject({
      review_total: null,
      review_tier: null,
      review_status: "unavailable",
    });
  });

  it("never stores a non-empty tier with zero reviews", async () => {
    const test = harness();
    const reviews = source(async () =>
      jsonResponse({
        success: 1,
        query_summary: {
          total_positive: 0,
          total_negative: 0,
          total_reviews: 0,
          review_score_desc: "No user reviews",
        },
      }),
    );

    await reviews.fetch(test.context);
    expect(reviewRow(test.db)?.review_tier).toBeNull();
  });
});

describe("SteamReviewSource malformed responses", () => {
  function seedOk(test: Harness, appId = APP_ID): void {
    test.db.raw
      .prepare(
        `INSERT INTO steam_review_summaries (
           app_id, review_positive, review_negative, review_total, review_tier,
           review_status, review_fetched_at, updated_at
         ) VALUES (?, 4900, 100, 5000, 'Overwhelmingly Positive', 'ok', ?, ?)`,
      )
      .run(appId, NOW - 60, NOW - 60);
  }

  function inconsistent(): unknown {
    return {
      success: 1,
      query_summary: {
        total_positive: 5,
        total_negative: 3,
        total_reviews: 9,
        review_score_desc: "Mixed",
      },
    };
  }

  it("keeps last-known-good values as stale for inconsistent counts", async () => {
    const test = harness();
    seedOk(test);
    const reviews = source(async () => jsonResponse(inconsistent()));

    const outcome = await reviews.fetch(test.context);

    expect(outcome).toMatchObject({ kind: "error" });
    expect(outcome.kind === "error" ? outcome.message : "").toMatch(/inconsistent counts/i);
    expect(reviewRow(test.db)).toMatchObject({
      review_positive: 4900,
      review_negative: 100,
      review_total: 5000,
      review_tier: "Overwhelmingly Positive",
      review_status: "stale",
      review_fetched_at: NOW - 60,
    });
    expect(reviewRow(test.db)?.raw_reviews_json).toBeNull();
  });

  it("records error with null values when inconsistent counts have no fallback", async () => {
    const test = harness();
    const reviews = source(async () => jsonResponse(inconsistent()));

    expect(await reviews.fetch(test.context)).toMatchObject({ kind: "error" });
    expect(reviewRow(test.db)).toMatchObject({
      review_positive: null,
      review_negative: null,
      review_total: null,
      review_tier: null,
      review_status: "error",
      review_error: "The Steam reviews response had inconsistent counts.",
    });
  });

  it("keeps last-known-good values for malformed JSON", async () => {
    const test = harness();
    seedOk(test);
    const reviews = source(
      async () =>
        new Response("not json at all", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await reviews.fetch(test.context);

    expect(outcome).toMatchObject({ kind: "error" });
    expect(reviewRow(test.db)).toMatchObject({
      review_total: 5000,
      review_status: "stale",
      review_fetched_at: NOW - 60,
    });
  });

  it("records a short safe error without exposing the body", async () => {
    const test = harness();
    const reviews = source(
      async () =>
        new Response("{ broken", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await reviews.fetch(test.context);
    expect(reviewRow(test.db)?.review_error).toBe("The Steam reviews response was not valid JSON.");
  });
});

describe("SteamReviewSource transport failures", () => {
  function seedOk(test: Harness, appId = APP_ID): void {
    test.db.raw
      .prepare(
        `INSERT INTO steam_review_summaries (
           app_id, review_positive, review_negative, review_total, review_tier,
           review_status, review_fetched_at, updated_at
         ) VALUES (?, 4900, 100, 5000, 'Overwhelmingly Positive', 'ok', ?, ?)`,
      )
      .run(appId, NOW - 60, NOW - 60);
  }

  it("treats a 302 as blocked without parsing the body", async () => {
    const test = harness();
    seedOk(test);
    const reviews = source(
      async () =>
        new Response("<html>redirect</html>", {
          status: 302,
          headers: { "content-type": "text/html", location: "https://store.steampowered.com/" },
        }),
    );

    const outcome = await reviews.fetch(test.context);

    expect(outcome).toMatchObject({ kind: "blocked" });
    expect(reviewRow(test.db)).toMatchObject({
      review_positive: 4900,
      review_total: 5000,
      review_status: "stale",
      review_fetched_at: NOW - 60,
    });
  });

  it("treats an HTML 200 as blocked without parsing it", async () => {
    const test = harness();
    seedOk(test);
    const reviews = source(
      async () =>
        new Response("<!doctype html><title>Steam</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    expect(await reviews.fetch(test.context)).toMatchObject({ kind: "blocked" });
    expect(reviewRow(test.db)?.review_status).toBe("stale");
    expect(reviewRow(test.db)?.review_total).toBe(5000);
  });

  it("treats 403 as blocked", async () => {
    const test = harness();
    seedOk(test);
    const reviews = source(async () => new Response("forbidden", { status: 403 }));

    expect(await reviews.fetch(test.context)).toMatchObject({ kind: "blocked" });
    expect(reviewRow(test.db)?.review_status).toBe("stale");
  });

  it("honours Retry-After on 429", async () => {
    const test = harness();
    seedOk(test);
    const reviews = source(
      async () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "120" },
        }),
    );

    const outcome = await reviews.fetch(test.context);

    expect(outcome).toEqual({
      kind: "rate_limited",
      retryAfterAt: NOW + 120,
      message: "Steam rate limited review requests. Try again later.",
    });
    expect(reviewRow(test.db)?.review_status).toBe("stale");
  });

  it("reports an unknown retry time when Retry-After is absent", async () => {
    const test = harness();
    const reviews = source(async () => new Response("slow down", { status: 429 }));

    expect(await reviews.fetch(test.context)).toMatchObject({
      kind: "rate_limited",
      retryAfterAt: null,
    });
  });

  it("returns error for a 5xx and keeps cached values", async () => {
    const test = harness();
    seedOk(test);
    const reviews = source(async () => new Response("upstream failed", { status: 503 }));

    const outcome = await reviews.fetch(test.context);

    expect(outcome).toMatchObject({ kind: "error" });
    expect(outcome.kind === "error" ? outcome.message : "").toMatch(/status 503/i);
    expect(reviewRow(test.db)).toMatchObject({ review_total: 5000, review_status: "stale" });
  });

  it("returns error for a network failure", async () => {
    const test = harness();
    const reviews = source(async () => {
      throw new TypeError("fetch failed");
    });

    const outcome = await reviews.fetch(test.context);

    expect(outcome).toEqual({
      kind: "error",
      message: "The Steam reviews request could not be reached.",
    });
    expect(reviewRow(test.db)?.review_status).toBe("error");
  });

  it("returns error when the request times out", async () => {
    const test = harness();
    const reviews = source(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      { timeoutMs: 5 },
    );

    const outcome = await reviews.fetch(test.context);

    expect(outcome).toEqual({
      kind: "error",
      message: "The Steam reviews request timed out.",
    });
  });
});

describe("SteamReviewSource state transitions", () => {
  it("moves ok -> stale -> ok without losing last-known-good values", async () => {
    const test = harness();
    let response = () => jsonResponse(SUMMARY);
    const reviews = source(async () => response());

    await reviews.fetch(test.context);
    expect(reviewRow(test.db)).toMatchObject({
      review_status: "ok",
      review_total: 5000,
      review_fetched_at: NOW,
    });

    response = () => new Response("failed", { status: 500 });
    const later = { ...test.context, now: NOW + 60 };
    await reviews.fetch(later);
    expect(reviewRow(test.db)).toMatchObject({
      review_status: "stale",
      review_total: 5000,
      review_tier: "Overwhelmingly Positive",
      review_fetched_at: NOW,
    });

    response = () =>
      jsonResponse({
        success: 1,
        query_summary: {
          total_positive: 4990,
          total_negative: 10,
          total_reviews: 5000,
          review_score_desc: "Overwhelmingly Positive",
        },
      });
    const recovered = { ...test.context, now: NOW + 120 };
    expect(await reviews.fetch(recovered)).toEqual({ kind: "ok" });
    expect(reviewRow(test.db)).toMatchObject({
      review_status: "ok",
      review_positive: 4990,
      review_total: 5000,
      review_fetched_at: NOW + 120,
    });
  });

  it("keeps a known zero as last-known-good when a later response fails", async () => {
    const test = harness();
    const zero = {
      success: 1,
      query_summary: {
        total_positive: 0,
        total_negative: 0,
        total_reviews: 0,
        review_score_desc: "No user reviews",
      },
    };
    let response = () => jsonResponse(zero);
    const reviews = source(async () => response());

    await reviews.fetch(test.context);
    expect(reviewRow(test.db)).toMatchObject({ review_total: 0, review_status: "unavailable" });

    response = () => jsonResponse({ success: 1, query_summary: { total_positive: 1 } });
    await reviews.fetch({ ...test.context, now: NOW + 60 });

    expect(reviewRow(test.db)).toMatchObject({
      review_positive: 0,
      review_negative: 0,
      review_total: 0,
      review_tier: null,
      review_status: "stale",
    });
  });

  it("never removes a Game or another source's data", async () => {
    const test = harness();
    test.db.raw
      .prepare(
        `INSERT INTO steamspy_appdetails (app_id, tags_status, tags_fetched_at, updated_at)
         VALUES (?, 'ok', ?, ?)`,
      )
      .run(APP_ID, NOW, NOW);
    test.db.raw
      .prepare(
        `INSERT INTO storefront_appdetails (app_id, type, store_status, store_fetched_at, updated_at)
         VALUES (?, 'game', 'ok', ?, ?)`,
      )
      .run(APP_ID, NOW, NOW);
    const reviews = source(async () => new Response("failed", { status: 500 }));

    await reviews.fetch(test.context);

    expect((test.db.raw.prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number }).n).toBe(
      1,
    );
    expect(
      (
        test.db.raw.prepare("SELECT COUNT(*) AS n FROM steamspy_appdetails").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(
      (
        test.db.raw.prepare("SELECT COUNT(*) AS n FROM storefront_appdetails").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(reviewRow(test.db)?.review_status).toBe("error");
  });
});
