import type {
  RefreshRun,
  RefreshStatus,
  SourceHealth,
  SourceName,
  SourceStatus,
  Status,
} from "../shared/types.ts";
import { fetchGames } from "./api.ts";

export type RefreshPhase = "library" | "ownership" | "metadata";

export type MetadataSource = "steamspy" | "storefront" | "steam_reviews";

export const METADATA_SOURCE_LABELS: Record<MetadataSource, string> = {
  steamspy: "SteamSpy",
  storefront: "Storefront",
  steam_reviews: "Reviews",
};

/** The three per-Game statuses that make a Metadata row affected (§7.7). */
export const AFFECTED_METADATA_STATUSES = ["missing", "stale", "error"] as const;

const METADATA_STATUS_FILTER: Record<MetadataSource, string> = {
  steamspy: "tagsStatus",
  storefront: "storeStatus",
  steam_reviews: "reviewStatus",
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
  return name === "steamspy" || name === "storefront" || name === "steam_reviews";
}

/**
 * Return the base name of the affected statuses. Kept as a small pure helper so
 * the `/errors` view and its tests agree on the exclusion of `ok` and
 * `unavailable`.
 */
export function affectedStatuses(): readonly string[] {
  return AFFECTED_METADATA_STATUSES;
}

export interface AffectedGames {
  ids: number[];
  count: number;
}

/**
 * Find Games whose status for a Metadata source is missing, stale, or error.
 * Counts come from `pagination.totalItems`; IDs are paged with the documented
 * `GET /api/games` filter so the selection bar can act on them.
 */
export async function fetchAffectedGames(
  source: MetadataSource,
  signal?: AbortSignal,
): Promise<AffectedGames> {
  const filter = METADATA_STATUS_FILTER[source];
  const ids = new Set<number>();
  let count = 0;

  for (const status of AFFECTED_METADATA_STATUSES) {
    const first = await fetchGames(
      { page: 1, pageSize: 200, [filter]: status } as Parameters<typeof fetchGames>[0],
      signal,
    );
    count += first.pagination.totalItems;
    for (const game of first.data) {
      ids.add(game.appId);
    }
    for (let page = 2; page <= first.pagination.totalPages; page += 1) {
      const next = await fetchGames(
        { page, pageSize: 200, [filter]: status } as Parameters<typeof fetchGames>[0],
        signal,
      );
      for (const game of next.data) {
        ids.add(game.appId);
      }
    }
  }

  return { ids: [...ids].sort((left, right) => left - right), count };
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
