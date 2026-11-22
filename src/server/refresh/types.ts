import type { ErrorDetail, RefreshMode, RefreshScope, RefreshStatus } from "../../shared/types.ts";
import type { LibraryScanResult } from "../library/scan.ts";
import type { MetadataSourceName } from "../../shared/types.ts";

/**
 * Internal shape shared by the Refresh worker and its phase modules. Nothing
 * here crosses the API boundary; `run-persistence.ts` converts rows to wire
 * types.
 */

export interface RefreshRow {
  id: number;
  scope: RefreshScope;
  mode: RefreshMode | null;
  status: RefreshStatus;
  steam_id64: string | null;
  started_at: number;
  finished_at: number | null;
  total: number | null;
  done: number;
  app_ids_json: string | null;
  error_code: string | null;
  error_message: string | null;
  stats_json: string | null;
}

export interface RefreshRequest {
  scope: RefreshScope;
  mode: RefreshMode | null;
  appIds: number[] | null;
}

/** The settings a run uses. A run keeps the snapshot it started with. */
export interface RunConfig {
  steamRoot: string | null;
  steamId64: string | null;
  steamApiKey: string | null;
}

export type CounterName = "candidates" | "done" | "failed" | "skipped";

export type SourceCounters = Record<CounterName, number>;

export interface InternalMetadataStats {
  sources: Record<MetadataSourceName, SourceCounters>;
  lastProgressAt: number;
}

export interface PhaseError {
  error: ErrorDetail | null;
  partial: boolean;
  fatal: boolean;
}

/** A shared-host pause: skipped passes inherit the reason that caused it. */
export interface HostPause {
  until: number;
  reason: "rate_limited" | "blocked";
}

export interface LibraryPhaseResult extends PhaseError {
  status: "succeeded" | "partial" | "failed";
  result: LibraryScanResult;
}

export interface OwnershipPhaseResult extends PhaseError {
  status: "succeeded" | "partial" | "failed" | "skipped";
  total: number | null;
  done: number;
}

export interface MetadataPhaseResult extends PhaseError {
  total: number;
  done: number;
  stats: InternalMetadataStats;
}

export interface WorkItem {
  appId: number;
  name: string;
}

export interface SelectionPlan {
  total: number;
  items: Map<MetadataSourceName, WorkItem[]>;
  /** App IDs in a Full Refresh that no longer have a Game row. */
  missingAppIds: number[];
  remainingByGame: Map<number, number>;
  done: number;
  stats: InternalMetadataStats;
  partial: boolean;
}
