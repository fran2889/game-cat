import { APP_VERSION, DB_SCHEMA_VERSION } from "../shared/app.ts";
import { SOURCE_ORDER, type SourceHealth, type Status } from "../shared/types.ts";
import type { SteamDiscovery } from "./steam/discovery.ts";

export interface BuildStatusInput {
  discovery: SteamDiscovery;
  steamApiKey: string | null;
  configuredSteamId64: string | null;
  schemaVersion?: number;
  version?: string;
}

/**
 * The walking-skeleton Status document. All Library and Metadata counts are
 * zero until the database (#22) and local scan (#23) land; the shape is final so
 * the client and wrappers can integrate now.
 */
export function buildStatus(input: BuildStatusInput): Status {
  const steamId64 = input.discovery.account?.steamId64 ?? input.configuredSteamId64 ?? null;
  const ownershipConfigured = input.steamApiKey !== null && steamId64 !== null;

  const sources: SourceHealth[] = SOURCE_ORDER.map((name) => ({
    name,
    status: name === "steam_web_api" && !ownershipConfigured ? "not_configured" : "unknown",
    lastSuccessAt: null,
    lastAttemptAt: null,
    retryAfterAt: null,
    lastError: null,
  }));

  return {
    app: {
      version: input.version ?? APP_VERSION,
      dbSchemaVersion: input.schemaVersion ?? DB_SCHEMA_VERSION,
    },
    steam: {
      state: input.discovery.state,
      root: input.discovery.root,
      account: input.discovery.account,
    },
    ownership: {
      state: ownershipConfigured ? "unknown" : "not_configured",
      gameCount: 0,
      lastSuccessAt: null,
      lastAttemptAt: null,
      error: null,
    },
    library: {
      gameCount: 0,
      installedCount: 0,
      lastScanAt: null,
      lastScanStatus: "never",
    },
    metadata: {
      tags: { ok: 0, missing: 0, stale: 0, error: 0 },
      store: { ok: 0, unavailable: 0, missing: 0, stale: 0, error: 0 },
      reviews: { ok: 0, unavailable: 0, missing: 0, stale: 0, error: 0 },
      lastSuccessAt: null,
    },
    sources,
    activeRefresh: null,
    lastRefresh: null,
  };
}
