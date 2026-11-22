import {
  METADATA_SOURCE_NAMES,
  type MetadataSourceName,
  type MetadataSourceStatus,
  type RefreshRun,
  type RefreshStatus,
  type SourceHealth,
  type SourceName,
  type SourceStatus,
  type Status,
} from "../shared/types.ts";
import { fetchGames, type FetchGamesParams } from "./api.ts";

export type RefreshPhase = "library" | "ownership" | "metadata";

export type MetadataSource = MetadataSourceName;

export const METADATA_SOURCE_LABELS: Record<MetadataSource, string> = {
  steamspy: "SteamSpy",
  storefront: "Storefront",
  steam_reviews: "Reviews",
};

/** The per-Game statuses that mean the last attempt failed (§7.7): `stale` or `error`. */
export const AFFECTED_METADATA_STATUSES: readonly MetadataSourceStatus[] = ["stale", "error"];

/** The status a never-attempted source reads as, before it has a fetch timestamp. */
const PENDING_METADATA_STATUS: MetadataSourceStatus = "missing";

interface MetadataFilters {
  status: "tagsStatus" | "storeStatus" | "reviewStatus";
  fetched: "tagsFetched" | "storeFetched" | "reviewFetched";
}

const METADATA_FILTERS: Record<MetadataSource, MetadataFilters> = {
  steamspy: { status: "tagsStatus", fetched: "tagsFetched" },
  storefront: { status: "storeStatus", fetched: "storeFetched" },
  steam_reviews: { status: "reviewStatus", fetched: "reviewFetched" },
};

/** Rebuild the request that produced a run, for a Retry with the same shape. */
export function refreshRequestFor(run: RefreshRun): {
  scope: RefreshRun["scope"];
  mode?: "fetch" | "full";
  appIds?: number[];
} {
  switch (run.scope) {
    case "all":
      return { scope: "all", mode: "fetch" };
    case "metadata":
      return run.mode === "full"
        ? { scope: "metadata", mode: "full", appIds: run.appIds ?? [] }
        : { scope: "metadata", mode: "fetch" };
    case "ownership":
      return { scope: "ownership" };
    case "library":
      return { scope: "library" };
  }
}

export function isTerminalStatus(status: RefreshStatus): boolean {
  return status === "succeeded" || status === "partial" || status === "failed";
}

export function isRunningStatus(status: RefreshStatus): boolean {
  return status === "queued" || status === "running";
}

/** The mode label shown in the banner: Fetch, Full Refresh, or a scope label. */
export function refreshModeLabel(run: RefreshRun): string {
  if (run.scope === "metadata") {
    return run.mode === "full" ? "Full Refresh" : "Fetch";
  }
  if (run.scope === "all") {
    return "Fetch";
  }
  if (run.scope === "ownership") {
    return "Ownership refresh";
  }
  return "Library scan";
}

export function refreshPhaseFromStatus(run: RefreshRun, status: Status | null): RefreshPhase {
  if (run.scope !== "all") {
    return run.scope === "metadata"
      ? "metadata"
      : run.scope === "ownership"
        ? "ownership"
        : "library";
  }
  if (run.total !== null) {
    return "metadata";
  }
  const startedAt = Date.parse(run.startedAt);
  const ownershipAt =
    status?.ownership.lastAttemptAt === null || status?.ownership.lastAttemptAt === undefined
      ? null
      : Date.parse(status.ownership.lastAttemptAt);
  if (ownershipAt !== null && !Number.isNaN(startedAt) && ownershipAt >= startedAt) {
    return "metadata";
  }
  const scanAt =
    status?.library.lastScanAt === null || status?.library.lastScanAt === undefined
      ? null
      : Date.parse(status.library.lastScanAt);
  if (scanAt !== null && !Number.isNaN(startedAt) && scanAt >= startedAt) {
    return "ownership";
  }
  return "library";
}

export function refreshPhaseTitle(
  run: RefreshRun,
  status: Status | null,
): "Reading Library" | "Fetching metadata" {
  return refreshPhaseFromStatus(run, status) === "metadata"
    ? "Fetching metadata"
    : "Reading Library";
}

export type RefreshCardTitle =
  | "Library up to date"
  | "Reading Library"
  | "Fetching metadata"
  | "Ownership incomplete"
  | "Not connected";

export function ownershipIncomplete(status: Status): boolean {
  return (
    status.ownership.state === "invalid_key" ||
    status.ownership.state === "error" ||
    status.ownership.state === "partial"
  );
}

export function refreshCardTitle(
  status: Status | null,
  activeRun: RefreshRun | null,
): RefreshCardTitle {
  if (status === null) {
    return "Not connected";
  }
  if (activeRun !== null) {
    return refreshPhaseTitle(activeRun, status);
  }
  if (ownershipIncomplete(status)) {
    return "Ownership incomplete";
  }
  return "Library up to date";
}

/** The later of the last successful scan, ownership run, and Metadata run. */
export function dataAsOf(status: Status): string | null {
  const values = [
    status.library.lastScanAt,
    status.ownership.lastSuccessAt,
    status.metadata.lastSuccessAt,
  ].filter((value): value is string => value !== null);
  if (values.length === 0) {
    return null;
  }
  return values.reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest,
  );
}

export function sourceStatusTone(status: SourceStatus): "ok" | "warning" | "error" | "neutral" {
  switch (status) {
    case "ok":
    case "empty":
      return "ok";
    case "partial":
    case "not_configured":
    case "rate_limited":
    case "unknown":
      return "warning";
    case "invalid_key":
    case "blocked":
    case "offline":
    case "error":
      return "error";
    default:
      return "neutral";
  }
}

export function isMetadataSource(name: SourceName): name is MetadataSource {
  return (METADATA_SOURCE_NAMES as readonly SourceName[]).includes(name);
}

export interface AffectedAndPendingGames {
  affectedIds: number[];
  affectedCount: number;
  /** Never-attempted Games: `missing` with no `*_fetched_at` (§7.7). */
  pendingCount: number;
}

function metadataQuery(
  filters: MetadataFilters,
  status: MetadataSourceStatus,
  page: number,
  pageSize: number,
  fetched?: boolean,
): FetchGamesParams {
  const query: FetchGamesParams = { page, pageSize };
  query[filters.status] = status;
  if (fetched !== undefined) {
    query[filters.fetched] = fetched;
  }
  return query;
}

/**
 * Find Games whose last attempt for a Metadata source failed (`stale` or
 * `error`) and count the Games the source has not attempted yet (`missing` with
 * `*_fetched_at IS NULL`). Settled misses are neither affected nor pending.
 * The affected count is the number of IDs collected, so the displayed number
 * and `Select affected` always agree. The pending count comes from
 * `pagination.totalItems`; IDs are paged with the documented `GET /api/games`
 * filters so the selection bar can act on them.
 */
export async function fetchAffectedAndPendingGames(
  source: MetadataSource,
  signal?: AbortSignal,
): Promise<AffectedAndPendingGames> {
  const filters = METADATA_FILTERS[source];
  const affectedIds = new Set<number>();

  const pending = await fetchGames(
    metadataQuery(filters, PENDING_METADATA_STATUS, 1, 1, false),
    signal,
  );
  const pendingCount = pending.pagination.totalItems;

  for (const status of AFFECTED_METADATA_STATUSES) {
    const first = await fetchGames(metadataQuery(filters, status, 1, 200), signal);
    for (const game of first.data) {
      affectedIds.add(game.appId);
    }
    for (let page = 2; page <= first.pagination.totalPages; page += 1) {
      const next = await fetchGames(metadataQuery(filters, status, page, 200), signal);
      for (const game of next.data) {
        affectedIds.add(game.appId);
      }
    }
  }

  return {
    affectedIds: [...affectedIds].sort((left, right) => left - right),
    affectedCount: affectedIds.size,
    pendingCount,
  };
}

export function sourceLabel(source: SourceHealth): string {
  switch (source.name) {
    case "steam_local":
      return "Steam local files";
    case "steam_web_api":
      return "Steam Web API";
    default:
      return METADATA_SOURCE_LABELS[source.name];
  }
}
