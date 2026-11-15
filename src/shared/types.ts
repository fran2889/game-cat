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

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface GamesResponse {
  data: GameSummary[];
  pagination: Pagination;
  meta: { dataAsOf: string | null };
}

export interface GameDetailResponse {
  data: GameDetail;
}

export type RefreshScope = "library" | "ownership" | "metadata" | "all";
export type RefreshMode = "fetch" | "full";
export type RefreshStatus = "queued" | "running" | "succeeded" | "partial" | "failed";

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
    account: SteamAccount | null;
  };
  ownership: {
    state: OwnershipState;
    gameCount: number;
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
