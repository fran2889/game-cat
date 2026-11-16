import type BetterSqlite3 from "better-sqlite3";
import { APP_NAME, APP_VERSION } from "../../shared/app.ts";
import { normalizeNameKey } from "../../shared/names.ts";
import { parseAppId } from "../app-id.ts";
import type {
  MetadataSource,
  MetadataSourceContext,
  MetadataSourceOutcome,
} from "../refresh/sources.ts";
import { parseRetryAfter } from "./retry-after.ts";

/**
 * The canonical Steam storefront adapter (spec §2.3, §2.7, §6.1, §6.6).
 *
 * The engine owns selection, pacing, retry, progress, and `source_state`. This
 * adapter makes exactly one request and persists only `storefront_appdetails`
 * plus the display name. It never throws and never touches another source.
 */

const ENDPOINT = "https://store.steampowered.com/api/appdetails";
const FILTERS = "basic,developers,publishers,genres,categories,release_date,metacritic,platforms";
const DEFAULT_TIMEOUT_MS = 15_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface StorefrontSourceOptions {
  /** Injectable HTTP boundary. Tests never touch the network. */
  fetch?: FetchLike;
  /** Descriptive User-Agent; never a browser UA (spec §6.1). */
  userAgent?: string;
  /** Abort a hung request; the engine treats it as a transient failure. */
  timeoutMs?: number;
}

interface StorefrontRow {
  type: string | null;
  developers_json: string;
  publishers_json: string;
  genres_json: string;
  categories_json: string;
  platforms_json: string;
  release_date_raw: string | null;
  metacritic_score: number | null;
  raw_store_json: string | null;
  store_status: string;
}

function defaultUserAgent(): string {
  return `${APP_NAME}/${APP_VERSION} (local Steam library app)`;
}

/** Extract the first four-digit year from a localized release string (§6.6). */
export function parseReleaseYear(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const match = /\b(\d{4})\b/.exec(raw);
  if (match === null) {
    return null;
  }
  const year = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(year) && year >= 1000 && year <= 2999 ? year : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "") {
      result.push(entry.trim());
    }
  }
  return result;
}

function namedObjects(value: unknown): Array<{ id: unknown; description: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: Array<{ id: unknown; description: string }> = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.description !== "string") {
      continue;
    }
    const description = entry.description.trim();
    if (description === "") {
      continue;
    }
    result.push({ id: entry.id, description });
  }
  return result;
}

function genreNames(value: unknown): string[] {
  return namedObjects(value).map((entry) => entry.description);
}

/** Deduplicate by Steam's numeric category ID; labels may repeat (§6.6). */
function categoryNames(value: unknown): string[] {
  const seen = new Set<number>();
  const result: string[] = [];
  for (const entry of namedObjects(value)) {
    const id =
      typeof entry.id === "number"
        ? entry.id
        : typeof entry.id === "string" && /^\d+$/.test(entry.id)
          ? Number.parseInt(entry.id, 10)
          : null;
    if (id === null || !Number.isSafeInteger(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push(entry.description);
  }
  return result;
}

function platformsObject(value: unknown): Record<string, boolean> {
  const platforms: Record<string, boolean> = {};
  if (!isRecord(value)) {
    return platforms;
  }
  for (const key of ["windows", "mac", "linux"] as const) {
    if (typeof value[key] === "boolean") {
      platforms[key] = value[key];
    }
  }
  return platforms;
}

function metacriticScore(value: unknown): number | null {
  if (!isRecord(value) || typeof value.score !== "number") {
    return null;
  }
  return Number.isSafeInteger(value.score) && value.score >= 0 ? value.score : null;
}

function releaseDateRaw(value: unknown): string | null {
  if (!isRecord(value) || typeof value.date !== "string" || value.date.trim() === "") {
    return null;
  }
  return value.date;
}

function hasStoreData(row: StorefrontRow | undefined): boolean {
  if (row === undefined) {
    return false;
  }
  return (
    row.store_status === "ok" ||
    row.raw_store_json !== null ||
    row.type !== null ||
    row.release_date_raw !== null ||
    row.metacritic_score !== null ||
    row.developers_json !== "[]" ||
    row.publishers_json !== "[]" ||
    row.genres_json !== "[]" ||
    row.categories_json !== "[]" ||
    row.platforms_json !== "{}"
  );
}

function readStorefrontRow(db: BetterSqlite3.Database, appId: number): StorefrontRow | undefined {
  return db
    .prepare(
      `SELECT type, developers_json, publishers_json, genres_json, categories_json,
              platforms_json, release_date_raw, metacritic_score, raw_store_json, store_status
       FROM storefront_appdetails WHERE app_id = ?`,
    )
    .get(appId) as StorefrontRow | undefined;
}

/**
 * Keep last-known-good canonical values and record a failed attempt. A Game
 * with usable previous data is `stale`; one without it is `error`.
 */
function recordFailure(
  db: BetterSqlite3.Database,
  appId: number,
  now: number,
  message: string,
): void {
  db.transaction(() => {
    const status = hasStoreData(readStorefrontRow(db, appId)) ? "stale" : "error";
    db.prepare(
      `INSERT INTO storefront_appdetails (app_id, store_status, store_error, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         store_status = excluded.store_status,
         store_error = excluded.store_error,
         updated_at = excluded.updated_at`,
    ).run(appId, status, message, now);
  })();
}

/** A successful answer with no usable store data is a settled `unavailable`. */
function recordUnavailable(db: BetterSqlite3.Database, appId: number, now: number): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO storefront_appdetails (
         app_id, store_status, store_fetched_at, store_error, updated_at
       ) VALUES (?, 'unavailable', ?, NULL, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         store_status = 'unavailable',
         store_fetched_at = excluded.store_fetched_at,
         store_error = NULL,
         updated_at = excluded.updated_at`,
    ).run(appId, now, now);
  })();
}

interface ParsedStorefront {
  type: string | null;
  name: string | null;
  developers: string[];
  publishers: string[];
  genres: string[];
  categories: string[];
  platforms: Record<string, boolean>;
  metacriticScore: number | null;
  releaseDateRaw: string | null;
  raw: string;
}

/**
 * A `success: true` payload keyed by a different App ID is not the requested
 * App's data. The outer key is the identity, so this is the only explicit
 * mismatch case; a canonical mapping keeps the requested outer key (spec §6.6).
 */
function mismatchedAppId(payload: unknown, appId: number): number | null {
  if (!isRecord(payload)) {
    return null;
  }
  const keys = Object.keys(payload);
  if (keys.length !== 1) {
    return null;
  }
  const key = keys[0]!;
  const returned = parseAppId(key);
  if (returned === null || returned === appId) {
    return null;
  }
  const entry = payload[key];
  return isRecord(entry) && entry.success === true ? returned : null;
}

function parseStorefrontData(data: Record<string, unknown>): ParsedStorefront {
  return {
    type: typeof data.type === "string" ? data.type : null,
    name: typeof data.name === "string" && data.name.trim() !== "" ? data.name.trim() : null,
    developers: stringArray(data.developers),
    publishers: stringArray(data.publishers),
    genres: genreNames(data.genres),
    categories: categoryNames(data.categories),
    platforms: platformsObject(data.platforms),
    metacriticScore: metacriticScore(data.metacritic),
    releaseDateRaw: releaseDateRaw(data.release_date),
    raw: JSON.stringify(data),
  };
}

function persistSuccess(
  db: BetterSqlite3.Database,
  appId: number,
  now: number,
  parsed: ParsedStorefront,
): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO storefront_appdetails (
         app_id, type, developers_json, publishers_json, genres_json, categories_json,
         platforms_json, release_date_raw, release_year, metacritic_score,
         store_status, store_fetched_at, store_error, raw_store_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?, NULL, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         type = excluded.type,
         developers_json = excluded.developers_json,
         publishers_json = excluded.publishers_json,
         genres_json = excluded.genres_json,
         categories_json = excluded.categories_json,
         platforms_json = excluded.platforms_json,
         release_date_raw = excluded.release_date_raw,
         release_year = excluded.release_year,
         metacritic_score = excluded.metacritic_score,
         store_status = 'ok',
         store_fetched_at = excluded.store_fetched_at,
         store_error = NULL,
         raw_store_json = excluded.raw_store_json,
         updated_at = excluded.updated_at`,
    ).run(
      appId,
      parsed.type,
      JSON.stringify(parsed.developers),
      JSON.stringify(parsed.publishers),
      JSON.stringify(parsed.genres),
      JSON.stringify(parsed.categories),
      JSON.stringify(parsed.platforms),
      parsed.releaseDateRaw,
      parseReleaseYear(parsed.releaseDateRaw),
      parsed.metacriticScore,
      now,
      parsed.raw,
      now,
    );

    // Storefront wins every name source, including its own prior value (§2.7).
    if (parsed.name !== null) {
      db.prepare(
        "UPDATE games SET name = ?, name_key = ?, name_source = 'storefront' WHERE app_id = ?",
      ).run(parsed.name, normalizeNameKey(parsed.name), appId);
    }
  })();
}

export class StorefrontSource implements MetadataSource {
  readonly name = "storefront" as const;
  readonly hostKey = "store" as const;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  constructor(options: StorefrontSourceOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.userAgent = options.userAgent ?? defaultUserAgent();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetch(context: MetadataSourceContext): Promise<MetadataSourceOutcome> {
    const { db, game, now } = context;
    try {
      return await this.request(db, game.appId, now, context.signal);
    } catch {
      // An adapter never throws; the engine classifies this as transient.
      try {
        recordFailure(db, game.appId, now, "The storefront request failed.");
      } catch {
        // A database failure is still not an adapter exception.
      }
      return { kind: "error", message: "The storefront request failed." };
    }
  }

  private async request(
    db: BetterSqlite3.Database,
    appId: number,
    now: number,
    outerSignal?: AbortSignal,
  ): Promise<MetadataSourceOutcome> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal =
      outerSignal === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, outerSignal]);
    return this.performRequest(db, appId, now, signal, outerSignal);
  }

  private async performRequest(
    db: BetterSqlite3.Database,
    appId: number,
    now: number,
    signal: AbortSignal,
    outerSignal?: AbortSignal,
  ): Promise<MetadataSourceOutcome> {
    const url = `${ENDPOINT}?appids=${appId}&cc=us&l=english&filters=${FILTERS}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { "user-agent": this.userAgent, accept: "application/json" },
        signal,
      });
    } catch {
      const message = outerSignal?.aborted
        ? "The storefront request was interrupted by shutdown."
        : signal.aborted
          ? "The storefront request timed out."
          : "The storefront request failed.";
      recordFailure(db, appId, now, message);
      return { kind: "error", message };
    }

    if (response.status === 429) {
      recordFailure(db, appId, now, "The storefront rate limited the request.");
      return {
        kind: "rate_limited",
        retryAfterAt: parseRetryAfter(response.headers.get("retry-after"), now),
        message: "The storefront rate limited the request.",
      };
    }
    if (response.status === 403) {
      recordFailure(db, appId, now, "The storefront blocked the request.");
      return { kind: "blocked", message: "The storefront blocked the request." };
    }
    if (response.status >= 300 && response.status < 400) {
      recordFailure(db, appId, now, "The storefront redirected the request.");
      return { kind: "blocked", message: "The storefront redirected the request." };
    }
    if (response.status === 400) {
      recordFailure(db, appId, now, "The storefront rejected the request shape.");
      return {
        kind: "error",
        message: "The storefront rejected the request shape.",
        retryable: false,
      };
    }
    if (response.status !== 200) {
      const message =
        response.status >= 500
          ? "The storefront is temporarily unavailable."
          : "The storefront rejected the request.";
      recordFailure(db, appId, now, message);
      return {
        kind: "error",
        message,
        retryable: response.status >= 500,
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      recordFailure(db, appId, now, "The storefront returned malformed JSON.");
      return { kind: "error", message: "The storefront returned malformed JSON." };
    }

    const entry = isRecord(payload) ? payload[String(appId)] : undefined;
    if (!isRecord(entry) || entry.success !== true) {
      const returned = mismatchedAppId(payload, appId);
      if (returned !== null) {
        // A safe diagnostic: both identities, never the raw payload.
        const message = `The storefront returned data for App ID ${returned}, not App ID ${appId}.`;
        recordFailure(db, appId, now, message);
        return { kind: "error", message, retryable: false };
      }
      recordUnavailable(db, appId, now);
      return { kind: "unavailable" };
    }

    const data = entry.data;
    if (!isRecord(data) || Object.keys(data).length === 0) {
      recordUnavailable(db, appId, now);
      return { kind: "unavailable" };
    }

    // Steam may canonicalize a library App ID while keeping the requested App
    // ID as the outer key. Store the response against the requested App ID; the
    // canonical ID remains in `raw_store_json` (spec §6.6).
    persistSuccess(db, appId, now, parseStorefrontData(data));
    return { kind: "ok" };
  }
}
