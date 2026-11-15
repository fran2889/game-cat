import type BetterSqlite3 from "better-sqlite3";
import { APP_NAME, APP_VERSION } from "../../shared/app.ts";
import { normalizeNameKey } from "../../shared/names.ts";
import type {
  MetadataSource,
  MetadataSourceContext,
  MetadataSourceOutcome,
} from "../refresh/sources.ts";
import { parseRetryAfter } from "./ownership.ts";

/**
 * SteamSpy `appdetails` adapter (spec §6.1, §6.5).
 *
 * One keyless request per Game. The adapter owns only its own
 * `steamspy_appdetails` row, the Tag vocabulary, and the Game's `game_tags`;
 * the Refresh engine owns `source_state`, retry, and `refresh_runs`.
 *
 * Upstream failures never throw. A failure keeps the last-known-good Tag set
 * and records `stale` (or `error` when there is nothing cached). A successful
 * response with no usable Tags removes the Game's Tags and records a settled
 * `missing`.
 */

export const STEAMSPY_ENDPOINT = "https://steamspy.com/api.php";
export const STEAMSPY_USER_AGENT = `${APP_NAME}/${APP_VERSION} (local Steam library app)`;

const DEFAULT_TIMEOUT_MS = 15_000;

export interface SteamSpySourceOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface SteamSpyTag {
  name: string;
  nameKey: string;
  votes: number;
}

type ParsedBody =
  | { kind: "ok"; name: string; tags: SteamSpyTag[]; raw: unknown }
  | { kind: "missing"; name: string | null; raw: unknown }
  | { kind: "malformed"; message: string };

function steamspyUrl(appId: number): URL {
  const url = new URL(STEAMSPY_ENDPOINT);
  url.searchParams.set("request", "appdetails");
  url.searchParams.set("appid", String(appId));
  return url;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Parse `tags` as `object<string, number>`; `[]`, `{}`, and absent are empty. */
function parseTags(value: unknown): SteamSpyTag[] | null {
  if (value === undefined || value === null || Array.isArray(value)) {
    return [];
  }
  if (typeof value !== "object") {
    return null;
  }

  // The response shape is case-sensitive, but Tag identity is not: combine
  // spellings that normalize to the same key, keeping the first spelling and
  // the largest vote count.
  const byKey = new Map<string, SteamSpyTag>();
  for (const [rawName, rawVotes] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim();
    const votes = nonNegativeInteger(rawVotes);
    if (name === "" || votes === null) {
      continue;
    }
    const nameKey = normalizeNameKey(name);
    const existing = byKey.get(nameKey);
    if (existing === undefined) {
      byKey.set(nameKey, { name, nameKey, votes });
    } else if (votes > existing.votes) {
      existing.votes = votes;
    }
  }
  return [...byKey.values()];
}

function classifyBody(body: unknown, requestedAppId: number): ParsedBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "malformed", message: "SteamSpy returned an unreadable response." };
  }
  const record = body as Record<string, unknown>;
  if (record.appid !== requestedAppId) {
    return {
      kind: "malformed",
      message: "SteamSpy returned a response for a different App.",
    };
  }

  const name = stringOrNull(record.name);
  const tags = parseTags(record.tags);
  if (tags === null) {
    return { kind: "malformed", message: "SteamSpy returned unreadable Tags." };
  }
  if (name === null) {
    // A zeroed record has a null name; it is a settled miss, not a failure.
    return tags.length === 0
      ? { kind: "missing", name: null, raw: body }
      : { kind: "malformed", message: "SteamSpy returned no Game name." };
  }
  if (tags.length === 0) {
    return { kind: "missing", name, raw: body };
  }
  return { kind: "ok", name, tags, raw: body };
}

function hasLastKnownGoodTags(db: BetterSqlite3.Database, appId: number): boolean {
  return (
    db.prepare("SELECT 1 AS present FROM game_tags WHERE app_id = ? LIMIT 1").get(appId) !==
    undefined
  );
}

function applyNameMatrix(db: BetterSqlite3.Database, appId: number, name: string): void {
  const nameKey = normalizeNameKey(name);
  db.prepare(
    `UPDATE games SET name = ?, name_key = ?, name_source = 'steamspy'
     WHERE app_id = ? AND name_source IN ('placeholder', 'steamspy')`,
  ).run(name, nameKey, appId);
}

function recordFailure(
  db: BetterSqlite3.Database,
  context: MetadataSourceContext,
  message: string,
): void {
  const status = hasLastKnownGoodTags(db, context.game.appId) ? "stale" : "error";
  db.prepare(
    `INSERT INTO steamspy_appdetails (app_id, tags_status, tags_error, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       tags_status = excluded.tags_status,
       tags_error = excluded.tags_error,
       updated_at = excluded.updated_at`,
  ).run(context.game.appId, status, message, context.now);
}

function storeSuccessfulResponse(
  db: BetterSqlite3.Database,
  context: MetadataSourceContext,
  parsed: Extract<ParsedBody, { kind: "ok" | "missing" }>,
): void {
  const { appId } = context.game;
  const tags = parsed.kind === "ok" ? parsed.tags : [];
  const name = parsed.name;
  const raw = JSON.stringify(parsed.raw);

  db.transaction(() => {
    db.prepare("DELETE FROM game_tags WHERE app_id = ?").run(appId);
    if (tags.length > 0) {
      const insertTag = db.prepare(
        "INSERT INTO tags (name, name_key) VALUES (?, ?) ON CONFLICT(name_key) DO NOTHING",
      );
      const selectTag = db.prepare("SELECT id FROM tags WHERE name_key = ?");
      const insertGameTag = db.prepare(
        "INSERT INTO game_tags (app_id, tag_id, votes) VALUES (?, ?, ?)",
      );
      for (const tag of tags) {
        insertTag.run(tag.name, tag.nameKey);
        const row = selectTag.get(tag.nameKey) as { id: number };
        insertGameTag.run(appId, row.id, tag.votes);
      }
    }

    db.prepare(
      `INSERT INTO steamspy_appdetails (
         app_id, steamspy_name, tags_status, tags_fetched_at, tags_error,
         raw_steamspy_json, updated_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         steamspy_name = COALESCE(excluded.steamspy_name, steamspy_appdetails.steamspy_name),
         tags_status = excluded.tags_status,
         tags_fetched_at = excluded.tags_fetched_at,
         tags_error = NULL,
         raw_steamspy_json = excluded.raw_steamspy_json,
         updated_at = excluded.updated_at`,
    ).run(appId, name, tags.length > 0 ? "ok" : "missing", context.now, raw, context.now);

    if (name !== null) {
      applyNameMatrix(db, appId, name);
    }
  })();
}

function failureOutcome(
  db: BetterSqlite3.Database,
  context: MetadataSourceContext,
  message: string,
): MetadataSourceOutcome {
  recordFailure(db, context, message);
  return { kind: "error", message };
}

export function createSteamSpySource(options: SteamSpySourceOptions = {}): MetadataSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "steamspy",

    async fetch(context: MetadataSourceContext): Promise<MetadataSourceOutcome> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(steamspyUrl(context.game.appId), {
            method: "GET",
            headers: {
              accept: "application/json",
              "user-agent": STEAMSPY_USER_AGENT,
            },
            signal: controller.signal,
          });
        } catch {
          return failureOutcome(
            context.db,
            context,
            controller.signal.aborted
              ? "The SteamSpy request timed out."
              : "SteamSpy could not be reached.",
          );
        }

        if (response.status === 403 || response.headers.get("cf-mitigated") === "challenge") {
          const message = "SteamSpy blocked or challenged the request.";
          recordFailure(context.db, context, message);
          return { kind: "blocked", message };
        }
        if (response.status === 429) {
          const message = "SteamSpy rate limited the request. Try again later.";
          recordFailure(context.db, context, message);
          return {
            kind: "rate_limited",
            retryAfterAt: parseRetryAfter(response.headers.get("retry-after"), context.now),
            message,
          };
        }
        if (response.status < 200 || response.status >= 300) {
          return failureOutcome(
            context.db,
            context,
            `The SteamSpy request failed with status ${response.status}.`,
          );
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return failureOutcome(context.db, context, "SteamSpy returned an unreadable response.");
        }

        const parsed = classifyBody(body, context.game.appId);
        if (parsed.kind === "malformed") {
          return failureOutcome(context.db, context, parsed.message);
        }

        storeSuccessfulResponse(context.db, context, parsed);
        return { kind: parsed.kind === "ok" ? "ok" : "missing" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
