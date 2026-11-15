import { APP_NAME, APP_VERSION } from "../../shared/app.ts";
import { parseRetryAfter } from "./retry-after.ts";

/**
 * Steam Web API ownership adapter (spec §6.10).
 *
 * The key is held only in this closure: it is never logged, returned, or
 * persisted. Every upstream failure is classified into a small result type so
 * the Refresh service can leave cached data intact.
 */

export const OWNERSHIP_ENDPOINT = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/";
export const OWNERSHIP_USER_AGENT = `${APP_NAME}/${APP_VERSION} (+https://github.com/fran2889/game-cat)`;

export interface OwnedGame {
  appId: number;
  name: string | null;
  playtimeForeverMinutes: number;
  playtime2WeeksMinutes: number | null;
}

export interface OwnershipSuccess {
  kind: "complete" | "partial" | "empty";
  gameCount: number;
  games: OwnedGame[];
}

export interface OwnershipInvalidKey {
  kind: "invalid_key";
  message: string;
}

export interface OwnershipRateLimited {
  kind: "rate_limited";
  /** Absolute Unix seconds from Retry-After, or `null` when absent. */
  retryAfterAt: number | null;
  message: string;
}

export interface OwnershipError {
  kind: "error";
  message: string;
}

export type OwnershipFetchResult =
  OwnershipSuccess | OwnershipInvalidKey | OwnershipRateLimited | OwnershipError;

export interface SteamOwnershipSource {
  /**
   * Fetch the roster for one SteamID64. Never throws for an upstream failure.
   * `signal` is aborted when the server shuts down.
   */
  fetchOwnedGames(steamId64: string, signal?: AbortSignal): Promise<OwnershipFetchResult>;
}

export interface SteamOwnershipSourceOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function ownershipUrl(apiKey: string, steamId64: string): URL {
  const url = new URL(OWNERSHIP_ENDPOINT);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("steamid", steamId64);
  url.searchParams.set("include_appinfo", "1");
  url.searchParams.set("include_played_free_games", "1");
  url.searchParams.set("language", "english");
  url.searchParams.set("format", "json");
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

function parseGames(value: unknown): OwnedGame[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const games = new Map<number, OwnedGame>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const appId = nonNegativeInteger(record.appid);
    if (appId === null || appId === 0) {
      continue;
    }
    if (!games.has(appId)) {
      games.set(appId, {
        appId,
        name: stringOrNull(record.name),
        playtimeForeverMinutes: nonNegativeInteger(record.playtime_forever) ?? 0,
        playtime2WeeksMinutes: nonNegativeInteger(record.playtime_2weeks),
      });
    }
  }
  return [...games.values()];
}

function classifyBody(body: unknown): OwnershipFetchResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "error", message: "The Steam Web API returned an unexpected response." };
  }
  const response = (body as { response?: unknown }).response;
  if (response === undefined) {
    return { kind: "empty", gameCount: 0, games: [] };
  }
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    return { kind: "error", message: "The Steam Web API returned an unexpected response." };
  }

  const record = response as Record<string, unknown>;
  const games = parseGames(record.games);
  if (games === null) {
    return { kind: "error", message: "The Steam Web API returned an unexpected response." };
  }

  const declared = nonNegativeInteger(record.game_count);
  if (games.length === 0 || declared === 0) {
    return { kind: "empty", gameCount: 0, games: [] };
  }

  // Only `game_count > 0` with an exactly matching roster is conclusive. A
  // missing `game_count` and a longer-than-declared roster are both
  // inconclusive: upsert what Steam returned, but never reconcile absent rows.
  if (declared === null) {
    return { kind: "partial", gameCount: games.length, games };
  }
  if (games.length !== declared) {
    return { kind: "partial", gameCount: declared, games };
  }
  return { kind: "complete", gameCount: declared, games };
}

export function createSteamOwnershipSource(
  options: SteamOwnershipSourceOptions,
): SteamOwnershipSource {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? unixSeconds;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async fetchOwnedGames(steamId64: string, signal?: AbortSignal): Promise<OwnershipFetchResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const combined =
        signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);
      try {
        let response: Response;
        try {
          response = await fetchImpl(ownershipUrl(options.apiKey, steamId64), {
            method: "GET",
            headers: {
              accept: "application/json",
              "user-agent": OWNERSHIP_USER_AGENT,
            },
            signal: combined,
          });
        } catch {
          // Deliberately generic: a thrown URL or cause may contain the key.
          return {
            kind: "error",
            message:
              signal?.aborted === true
                ? "The Steam Web API request was interrupted by shutdown."
                : controller.signal.aborted
                  ? "The Steam Web API request timed out."
                  : "The Steam Web API could not be reached.",
          };
        }

        if (response.status === 401 || response.status === 403) {
          return {
            kind: "invalid_key",
            message: "Steam rejected the Web API key. Check it in onboarding.",
          };
        }
        if (response.status === 429) {
          return {
            kind: "rate_limited",
            retryAfterAt: parseRetryAfter(response.headers.get("retry-after"), now()),
            message: "Steam rate limited the ownership request. Try again later.",
          };
        }
        if (response.status < 200 || response.status >= 300) {
          return {
            kind: "error",
            message: `The Steam Web API failed with status ${response.status}.`,
          };
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return {
            kind: "error",
            message: "The Steam Web API returned an unreadable response.",
          };
        }
        return classifyBody(body);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
