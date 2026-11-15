/**
 * Shared API and domain contracts.
 *
 * Only wire-facing shapes belong here: both the Fastify server and the React
 * client import this module. Database rows and Steam parser internals stay in
 * the server tree.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

export type SteamState = "ready" | "not_found" | "no_account" | "error";

export type SourceName =
  "steam_local" | "steam_web_api" | "steamspy" | "storefront" | "steam_reviews";

export const SOURCE_ORDER: readonly SourceName[] = [
  "steam_local",
  "steam_web_api",
  "steamspy",
  "storefront",
  "steam_reviews",
];

export type SourceStatus =
  | "unknown"
  | "ok"
  | "partial"
  | "empty"
  | "stale"
  | "not_configured"
  | "invalid_key"
  | "rate_limited"
  | "blocked"
  | "offline"
  | "error";

export type OwnershipState =
  | "unknown"
  | "ok"
  | "partial"
  | "empty"
  | "not_configured"
  | "invalid_key"
  | "rate_limited"
  | "error";

export type LibraryScanStatus = "never" | "ok" | "partial" | "failed";

export type OwnershipStatus = "owned" | "local_only" | "unknown";

/** The documented `GET /api/games` sort whitelist. */
export const GAME_SORTS = [
  "name",
  "playtime",
  "lastPlayed",
  "releaseYear",
  "metacritic",
  "appId",
] as const;
export type GameSort = (typeof GAME_SORTS)[number];
export type GameOrder = "asc" | "desc";

/** The four client view kinds that own a layout and a selection. */
export type ViewKind = "library" | "installed" | "smart" | "steam";

export type ReviewTone = "great" | "good" | "mixed" | "bad" | "none";

export type MetadataSourceStatus =
  | "ok"
  | "unavailable"
  | "missing"
  | "stale"
  | "error"
  | "not_configured"
  | "invalid_key"
  | "rate_limited"
  | "blocked"
  | "offline"
  | "unknown";

export interface GameTag {
  name: string;
  votes: number;
}

export interface TagSummary {
  name: string;
  gameCount: number;
}

export interface GamePlatforms {
  windows?: boolean;
  mac?: boolean;
  linux?: boolean;
}

export interface GameMetadataStatus {
  tagsStatus: string;
  storeStatus: string;
  reviewStatus: string;
  tagsFetchedAt?: string | null;
  storeFetchedAt?: string | null;
  reviewFetchedAt?: string | null;
}

export interface GameSummary {
  appId: number;
  name: string;
  ownershipStatus: OwnershipStatus;
  installed: boolean | null;
  playtimeMinutes: number;
  lastPlayedAt: string | null;
  releaseYear: number | null;
  metacriticScore: number | null;
  reviewScore: number | null;
  reviewTier: string | null;
  reviewCount: number | null;
  type: string | null;
  platforms: GamePlatforms | null;
  tags: GameTag[];
  metadata: GameMetadataStatus;
}

export interface GameDetail extends GameSummary {
  releaseDateRaw: string | null;
  developers: string[];
  publishers: string[];
  genres: string[];
  categories: string[];
  steamCollections: Array<{ id: string; name: string; kind: string }>;
  sizeOnDiskBytes: number | null;
}

export type SteamCollectionKind = "favorite" | "hidden" | "user" | "tag" | "system" | "other";

/** Read-only Steam Collection metadata; never contains a filterSpec. */
export interface SteamCollectionSummary {
  id: string;
  name: string;
  kind: SteamCollectionKind;
  isDynamic: boolean;
  /** Static membership count; `null` for a dynamic Collection. */
  gameCount: number | null;
}

export interface SteamCollectionsResponse {
  data: SteamCollectionSummary[];
  pagination: Pagination;
}

export interface SteamCollectionGamesResponse {
  data: GameSummary[];
  pagination: Pagination;
  meta: { dataAsOf: string | null; dynamic: boolean };
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/** The four storefront-backed Rule value pickers (§4.3). */
export type RuleValueField = "genre" | "category" | "developer" | "publisher";

export interface RuleValue {
  value: string;
  gameCount: number;
}

export interface RuleValuesResponse {
  data: RuleValue[];
  pagination: Pagination;
}

export interface GamesResponse {
  data: GameSummary[];
  pagination: Pagination;
  meta: { dataAsOf: string | null };
}

export interface TagsResponse {
  data: TagSummary[];
  pagination: Pagination;
}

export interface GameDetailResponse {
  data: GameDetail;
}

export type RefreshScope = "library" | "ownership" | "metadata" | "all";
export type RefreshMode = "fetch" | "full";
export type RefreshStatus = "queued" | "running" | "succeeded" | "partial" | "failed";

/** The documented `appIds` selection cap (§4.4). */
export const MAX_REFRESH_APP_IDS = 5_000;

export interface ErrorDetail {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

export interface ErrorResponse {
  error: ErrorDetail;
}

export interface SteamAccount {
  steamId64: string;
  accountId: string;
  personaName: string;
}

export interface RefreshRun {
  id: string;
  scope: RefreshScope;
  mode: RefreshMode | null;
  status: RefreshStatus;
  startedAt: string;
  finishedAt: string | null;
  total: number | null;
  done: number;
  appIds: number[] | null;
  stats: {
    sources: Record<
      "steamspy" | "storefront" | "steam_reviews",
      { candidates: number; done: number; failed: number; skipped: number }
    >;
  } | null;
  error: ErrorDetail | null;
}

export interface SourceHealth {
  name: SourceName;
  status: SourceStatus;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  retryAfterAt: string | null;
  lastError: string | null;
}

export interface Status {
  app: {
    version: string;
    dbSchemaVersion: number;
  };
  steam: {
    state: SteamState;
    root: string | null;
    /** Several local Accounts and no unique MostRecent; the picker is required. */
    ambiguous: boolean;
    account: SteamAccount | null;
  };
  ownership: {
    state: OwnershipState;
    /** Owned Games. */
    gameCount: number;
    /** Library-wide Ownership flags, used by the Library status surface. */
    counts: {
      owned: number;
      localOnly: number;
      unknown: number;
    };
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    error: ErrorDetail | null;
  };
  library: {
    gameCount: number;
    installedCount: number;
    lastScanAt: string | null;
    lastScanStatus: LibraryScanStatus;
  };
  metadata: {
    tags: Record<"ok" | "missing" | "stale" | "error", number>;
    store: Record<"ok" | "unavailable" | "missing" | "stale" | "error", number>;
    reviews: Record<"ok" | "unavailable" | "missing" | "stale" | "error", number>;
    lastSuccessAt: string | null;
  };
  sources: SourceHealth[];
  activeRefresh: RefreshRun | null;
  lastRefresh: RefreshRun | null;
}

export interface StatusResponse {
  data: Status;
}

/** Public configuration. Never contains the Steam Web API key. */
export interface Config {
  dataDir: string;
  steamRoot: string | null;
  steamId64: string | null;
  port: number;
  listeningUrl: string;
  openBrowser: boolean;
  logLevel: LogLevel;
  steamApiKeySet: boolean;
  steamApiKeySource: "file" | "env" | "none";
}

export interface ConfigResponse {
  data: Config;
  meta?: Record<string, unknown>;
}

export interface ConfigPatchResponse {
  data: Config;
  meta: { restartRequired: boolean };
}

export interface SteamAccountsResponse {
  data: SteamAccount[];
  pagination: Pagination;
}

export const ERROR_CODES = {
  malformedJson: "MALFORMED_JSON",
  hostNotAllowed: "HOST_NOT_ALLOWED",
  originNotAllowed: "ORIGIN_NOT_ALLOWED",
  notFound: "NOT_FOUND",
  payloadTooLarge: "PAYLOAD_TOO_LARGE",
  unsupportedMediaType: "UNSUPPORTED_MEDIA_TYPE",
  validationError: "VALIDATION_ERROR",
  internalError: "INTERNAL_ERROR",
} as const;
