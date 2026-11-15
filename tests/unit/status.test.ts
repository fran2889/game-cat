import { describe, expect, it } from "vitest";
import { buildStatus } from "../../src/server/status.ts";
import type { SteamDiscovery } from "../../src/server/steam/discovery.ts";
import { APP_VERSION } from "../../src/shared/app.ts";

const discovery: SteamDiscovery = {
  root: "/home/tester/.local/share/Steam",
  state: "ready",
  accounts: [
    {
      steamId64: "76561198000000000",
      accountId: "39734272",
      personaName: "Fran",
    },
  ],
  account: {
    steamId64: "76561198000000000",
    accountId: "39734272",
    personaName: "Fran",
  },
  ambiguous: false,
  error: null,
};

describe("Status document", () => {
  it("AC-A16 returns a complete shape for an empty Library", () => {
    const status = buildStatus({
      discovery,
      steamApiKey: "secret",
      configuredSteamId64: null,
      schemaVersion: 0,
      version: APP_VERSION,
    });

    expect(status.app).toEqual({ version: APP_VERSION, dbSchemaVersion: 0 });
    expect(status.steam.state).toBe("ready");
    expect(status.steam.account?.personaName).toBe("Fran");
    expect(status.ownership.state).toBe("unknown");
    expect(status.library).toEqual({
      gameCount: 0,
      installedCount: 0,
      lastScanAt: null,
      lastScanStatus: "never",
    });
    expect(status.metadata.tags).toEqual({ ok: 0, missing: 0, stale: 0, error: 0 });
    expect(status.metadata.store).toEqual({
      ok: 0,
      unavailable: 0,
      missing: 0,
      stale: 0,
      error: 0,
    });
    expect(status.sources.map((source) => source.name)).toEqual([
      "steam_local",
      "steam_web_api",
      "steamspy",
      "storefront",
      "steam_reviews",
    ]);
    expect(status.sources.every((source) => source.lastError === null)).toBe(true);
    expect(status.activeRefresh).toBeNull();
    expect(status.lastRefresh).toBeNull();
  });

  it("reports not_configured ownership without a key or account", () => {
    const status = buildStatus({
      discovery: { ...discovery, state: "no_account", account: null },
      steamApiKey: null,
      configuredSteamId64: null,
      schemaVersion: 0,
      version: APP_VERSION,
    });
    expect(status.ownership.state).toBe("not_configured");
    expect(status.steam.account).toBeNull();
    expect(status.sources.find((source) => source.name === "steam_web_api")?.status).toBe(
      "not_configured",
    );
  });

  it("reports not_found Steam without failing", () => {
    const status = buildStatus({
      discovery: {
        root: null,
        state: "not_found",
        accounts: [],
        account: null,
        ambiguous: false,
        error: null,
      },
      steamApiKey: null,
      configuredSteamId64: null,
      schemaVersion: 0,
      version: APP_VERSION,
    });
    expect(status.steam.state).toBe("not_found");
    expect(status.steam.root).toBeNull();
  });
});
