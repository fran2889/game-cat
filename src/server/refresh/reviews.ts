import type BetterSqlite3 from "better-sqlite3";
import { APP_NAME, APP_VERSION } from "../../shared/app.ts";
import { parseRetryAfter } from "../steam/retry-after.ts";
import type { MetadataSource, MetadataSourceContext, MetadataSourceOutcome } from "./sources.ts";

/**
 * Steam review summary adapter (spec §2.3, §6.1, §6.7).
 *
 * One keyless `appreviews` request per Game. The adapter owns only its
 * `steam_review_summaries` row; the Refresh engine owns retry, pacing, and
 * `source_state`. It shares the `store` host key with the storefront adapter.
 */

export const REVIEWS_HOST = "store.steampowered.com";
export const REVIEWS_USER_AGENT = `${APP_NAME}/${APP_VERSION} (local Steam library app)`;

const DEFAULT_TIMEOUT_MS = 15_000;

export interface SteamReviewSourceOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function reviewsUrl(appId: number): string {
  return `https://${REVIEWS_HOST}/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=0&l=english`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

interface ReviewCounts {
  positive: number;
  negative: number;
  total: number;
  tier: string;
}

/** Validate a usable `query_summary`. Returns a reason instead of throwing. */
export function parseReviewSummary(
  body: unknown,
):
  | { kind: "ok"; counts: ReviewCounts }
  | { kind: "zero" }
  | { kind: "empty" }
  | { kind: "malformed"; message: string } {
  if (!isRecord(body)) {
    return { kind: "malformed", message: "The Steam reviews response was not an object." };
  }
  if (body.success !== 1 || !isRecord(body.query_summary)) {
    return { kind: "empty" };
  }

  const summary = body.query_summary;
  const positive = nonNegativeInteger(summary.total_positive);
  const negative = nonNegativeInteger(summary.total_negative);
  const total = nonNegativeInteger(summary.total_reviews);
  const tier = typeof summary.review_score_desc === "string" ? summary.review_score_desc : "";
  if (positive === null || negative === null || total === null) {
    return { kind: "malformed", message: "The Steam reviews response had invalid counts." };
  }
  if (positive + negative !== total) {
    return { kind: "malformed", message: "The Steam reviews response had inconsistent counts." };
  }
  if (total === 0) {
    return { kind: "zero" };
  }
  const trimmedTier = tier.trim();
  if (trimmedTier === "" || trimmedTier.toLowerCase() === "no user reviews") {
    return { kind: "malformed", message: "The Steam reviews response had no review tier." };
  }
  return { kind: "ok", counts: { positive, negative, total, tier } };
}

function lkg(sqlite: BetterSqlite3.Database, appId: number): boolean {
  const row = sqlite
    .prepare("SELECT review_total FROM steam_review_summaries WHERE app_id = ?")
    .get(appId) as { review_total: number | null } | undefined;
  return row?.review_total !== null && row?.review_total !== undefined;
}

function upsert(
  sqlite: BetterSqlite3.Database,
  appId: number,
  fields: {
    positive: number | null;
    negative: number | null;
    total: number | null;
    tier: string | null;
    status: "ok" | "unavailable" | "stale" | "error";
    fetchedAt: number | null;
    error: string | null;
    raw: string | null;
    now: number;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO steam_review_summaries (
         app_id, review_positive, review_negative, review_total, review_tier,
         review_status, review_fetched_at, review_error, raw_reviews_json, updated_at
       ) VALUES (
         @appId, @positive, @negative, @total, @tier,
         @status, @fetchedAt, @error, @raw, @now
       )
       ON CONFLICT(app_id) DO UPDATE SET
         review_positive = excluded.review_positive,
         review_negative = excluded.review_negative,
         review_total = excluded.review_total,
         review_tier = excluded.review_tier,
         review_status = excluded.review_status,
         review_fetched_at = excluded.review_fetched_at,
         review_error = excluded.review_error,
         raw_reviews_json = excluded.raw_reviews_json,
         updated_at = excluded.updated_at`,
    )
    .run({ appId, ...fields });
}

/** Keep last-known-good values, or clear them when there is nothing to keep. */
function recordFailure(
  sqlite: BetterSqlite3.Database,
  appId: number,
  now: number,
  message: string,
): void {
  if (lkg(sqlite, appId)) {
    sqlite
      .prepare(
        `UPDATE steam_review_summaries
         SET review_status = 'stale', review_error = ?, updated_at = ?
         WHERE app_id = ?`,
      )
      .run(message, now, appId);
    return;
  }
  upsert(sqlite, appId, {
    positive: null,
    negative: null,
    total: null,
    tier: null,
    status: "error",
    fetchedAt: null,
    error: message,
    raw: null,
    now,
  });
}

function recordSuccess(
  sqlite: BetterSqlite3.Database,
  appId: number,
  now: number,
  counts: ReviewCounts,
  raw: string,
): void {
  upsert(sqlite, appId, {
    positive: counts.positive,
    negative: counts.negative,
    total: counts.total,
    tier: counts.tier,
    status: "ok",
    fetchedAt: now,
    error: null,
    raw,
    now,
  });
}

function recordZero(sqlite: BetterSqlite3.Database, appId: number, now: number, raw: string): void {
  upsert(sqlite, appId, {
    positive: 0,
    negative: 0,
    total: 0,
    tier: null,
    status: "unavailable",
    fetchedAt: now,
    error: null,
    raw,
    now,
  });
}

function recordEmpty(
  sqlite: BetterSqlite3.Database,
  appId: number,
  now: number,
  raw: string,
): void {
  const message = "Steam returned no usable review summary.";
  if (lkg(sqlite, appId)) {
    sqlite
      .prepare(
        `UPDATE steam_review_summaries
         SET review_status = 'stale', review_error = ?, raw_reviews_json = ?, updated_at = ?
         WHERE app_id = ?`,
      )
      .run(message, raw, now, appId);
    return;
  }
  upsert(sqlite, appId, {
    positive: null,
    negative: null,
    total: null,
    tier: null,
    status: "unavailable",
    fetchedAt: now,
    error: message,
    raw,
    now,
  });
}

export class SteamReviewSource implements MetadataSource {
  readonly name = "steam_reviews" as const;
  readonly hostKey = "store";

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SteamReviewSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetch(context: MetadataSourceContext): Promise<MetadataSourceOutcome> {
    const { db, game, now } = context;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal =
      context.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, context.signal]);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(reviewsUrl(game.appId), {
          method: "GET",
          headers: { accept: "application/json", "user-agent": REVIEWS_USER_AGENT },
          redirect: "manual",
          signal,
        });
      } catch {
        const message = context.signal?.aborted
          ? "The Steam reviews request was interrupted by shutdown."
          : controller.signal.aborted
            ? "The Steam reviews request timed out."
            : "The Steam reviews request could not be reached.";
        recordFailure(db, game.appId, now, message);
        return { kind: "error", message };
      }

      if (response.status >= 300 && response.status < 400) {
        const message = "Steam blocked the review request with a redirect.";
        recordFailure(db, game.appId, now, message);
        return { kind: "blocked", message };
      }
      if (response.status === 403) {
        const message = "Steam blocked the review request.";
        recordFailure(db, game.appId, now, message);
        return { kind: "blocked", message };
      }
      if (response.status === 429) {
        const message = "Steam rate limited review requests. Try again later.";
        recordFailure(db, game.appId, now, message);
        return {
          kind: "rate_limited",
          retryAfterAt: parseRetryAfter(response.headers.get("retry-after"), now),
          message,
        };
      }
      if (response.status < 200 || response.status >= 300) {
        const message = `The Steam reviews request failed with status ${response.status}.`;
        recordFailure(db, game.appId, now, message);
        return { kind: "error", message };
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      let text: string;
      try {
        text = await response.text();
      } catch {
        const message = "The Steam reviews response could not be read.";
        recordFailure(db, game.appId, now, message);
        return { kind: "error", message };
      }

      if (contentType.includes("html") || text.trimStart().startsWith("<")) {
        const message = "Steam returned a page instead of review JSON.";
        recordFailure(db, game.appId, now, message);
        return { kind: "blocked", message };
      }
      if (contentType !== "" && !contentType.includes("json")) {
        const message = "Steam returned an unexpected review response.";
        recordFailure(db, game.appId, now, message);
        return { kind: "blocked", message };
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        const message = "The Steam reviews response was not valid JSON.";
        recordFailure(db, game.appId, now, message);
        return { kind: "error", message };
      }

      const parsed = parseReviewSummary(body);
      if (parsed.kind === "ok") {
        recordSuccess(db, game.appId, now, parsed.counts, JSON.stringify(body));
        return { kind: "ok" };
      }
      if (parsed.kind === "zero") {
        recordZero(db, game.appId, now, JSON.stringify(body));
        return { kind: "unavailable" };
      }
      if (parsed.kind === "empty") {
        recordEmpty(db, game.appId, now, JSON.stringify(body));
        return { kind: "unavailable" };
      }
      recordFailure(db, game.appId, now, parsed.message);
      return { kind: "error", message: parsed.message };
    } finally {
      clearTimeout(timer);
    }
  }
}
