import { afterEach, describe, expect, it, vi } from "vitest";
import type { GamesResponse, RefreshRun, Status } from "../../src/shared/types.ts";
import {
  affectedStatuses,
  dataAsOf,
  fetchAffectedAndPendingGames,
  refreshCardTitle,
  refreshModeLabel,
  refreshPhaseFromStatus,
  refreshRequestFor,
  sourceStatusTone,
} from "../../src/client/refresh.ts";

function run(overrides: Partial<RefreshRun> = {}): RefreshRun {
  return {
    id: "1",
    scope: "metadata",
    mode: "fetch",
    status: "running",
    startedAt: "2026-11-15T10:00:00Z",
    finishedAt: null,
    total: null,
    done: 0,
    appIds: null,
    stats: null,
    error: null,
    ...overrides,
  };
}

function status(overrides: Partial<Status> = {}): Status {
  const base: Status = {
    app: { version: "1.0.0", dbSchemaVersion: 1 },
    steam: { state: "ready", root: "/steam", ambiguous: false, account: null },
    ownership: {
      state: "ok",
      gameCount: 0,
      counts: { owned: 0, localOnly: 0, unknown: 0 },
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
    sources: [],
    activeRefresh: null,
    lastRefresh: null,
  };
  return { ...base, ...overrides };
}

describe("Refresh mode and phase", () => {
  it("labels Fetch, Full Refresh, and scope-only runs", () => {
    expect(refreshModeLabel(run({ scope: "all", mode: "fetch" }))).toBe("Fetch");
    expect(refreshModeLabel(run({ scope: "metadata", mode: "fetch" }))).toBe("Fetch");
    expect(refreshModeLabel(run({ scope: "metadata", mode: "full", appIds: [1] }))).toBe(
      "Full Refresh",
    );
    expect(refreshModeLabel(run({ scope: "library", mode: null }))).toBe("Library scan");
  });

  it("derives the all-run phase from the metadata total and status timestamps", () => {
    const all = run({ scope: "all", mode: "fetch" });
    expect(refreshPhaseFromStatus(all, status())).toBe("library");
    expect(
      refreshPhaseFromStatus(
        all,
        status({
          library: {
            gameCount: 1,
            installedCount: 0,
            lastScanAt: "2026-11-15T10:01:00Z",
            lastScanStatus: "ok",
          },
        }),
      ),
    ).toBe("ownership");
    expect(refreshPhaseFromStatus(run({ scope: "all", total: 10 }), status())).toBe("metadata");
    expect(refreshPhaseFromStatus(run({ scope: "metadata" }), status())).toBe("metadata");
    expect(refreshPhaseFromStatus(run({ scope: "library", mode: null }), status())).toBe("library");
  });
});

describe("Refresh status card", () => {
  it("uses the five documented card states", () => {
    expect(refreshCardTitle(null, null)).toBe("Not connected");
    expect(
      refreshCardTitle(
        status({
          ownership: {
            ...status().ownership,
            state: "invalid_key",
          },
        }),
        null,
      ),
    ).toBe("Ownership incomplete");
    expect(refreshCardTitle(status(), null)).toBe("Library up to date");
    expect(refreshCardTitle(status(), run({ scope: "library", mode: null }))).toBe(
      "Reading Library",
    );
    expect(refreshCardTitle(status(), run({ scope: "metadata" }))).toBe("Fetching metadata");
  });

  it("uses the later successful timestamp as dataAsOf", () => {
    expect(dataAsOf(status())).toBeNull();
    expect(
      dataAsOf(
        status({
          library: {
            gameCount: 1,
            installedCount: 0,
            lastScanAt: "2026-11-15T10:00:00Z",
            lastScanStatus: "ok",
          },
          ownership: {
            ...status().ownership,
            lastSuccessAt: "2026-11-15T11:00:00Z",
          },
          metadata: {
            ...status().metadata,
            lastSuccessAt: "2026-11-15T12:00:00Z",
          },
        }),
      ),
    ).toBe("2026-11-15T12:00:00Z");
  });
});

describe("Retry requests keep the run shape", () => {
  it("reconstructs the documented request for every scope", () => {
    expect(refreshRequestFor(run({ scope: "all", mode: "fetch" }))).toEqual({
      scope: "all",
      mode: "fetch",
    });
    expect(refreshRequestFor(run({ scope: "metadata", mode: "fetch" }))).toEqual({
      scope: "metadata",
      mode: "fetch",
    });
    expect(refreshRequestFor(run({ scope: "metadata", mode: "full", appIds: [3, 4] }))).toEqual({
      scope: "metadata",
      mode: "full",
      appIds: [3, 4],
    });
    expect(refreshRequestFor(run({ scope: "ownership", mode: null }))).toEqual({
      scope: "ownership",
    });
    expect(refreshRequestFor(run({ scope: "library", mode: null }))).toEqual({ scope: "library" });
  });
});

describe("Source health helpers", () => {
  it("maps source statuses to tones and keeps ok/unavailable out of affected sets", () => {
    expect(sourceStatusTone("ok")).toBe("ok");
    expect(sourceStatusTone("rate_limited")).toBe("warning");
    expect(sourceStatusTone("invalid_key")).toBe("error");
    expect(affectedStatuses()).toEqual(["stale", "error"]);
    expect(affectedStatuses()).not.toContain("missing");
    expect(affectedStatuses()).not.toContain("ok");
    expect(affectedStatuses()).not.toContain("unavailable");
  });
});

describe("Affected and pending Games", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts only stale and error as affected, and never-attempted missing as pending", async () => {
    const requests: URLSearchParams[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input), "http://game-cat.test");
      requests.push(url.searchParams);
      const status = url.searchParams.get("tagsStatus");
      const fetched = url.searchParams.get("tagsFetched");
      let body: GamesResponse;
      if (status === "missing" && fetched === "false") {
        body = {
          data: [],
          pagination: { page: 1, pageSize: 1, totalItems: 7, totalPages: 7 },
          meta: { dataAsOf: null },
        };
      } else if (status === "stale") {
        body = {
          data: [gameSummary(3), gameSummary(9)],
          pagination: { page: 1, pageSize: 200, totalItems: 2, totalPages: 1 },
          meta: { dataAsOf: null },
        };
      } else if (status === "error") {
        body = {
          data: [gameSummary(4)],
          pagination: { page: 1, pageSize: 200, totalItems: 1, totalPages: 1 },
          meta: { dataAsOf: null },
        };
      } else {
        throw new Error(`Unexpected request: ${url.toString()}`);
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(fetchAffectedAndPendingGames("steamspy")).resolves.toEqual({
      affectedIds: [3, 4, 9],
      affectedCount: 3,
      pendingCount: 7,
    });
    expect(
      requests.some(
        (query) => query.get("tagsStatus") === "missing" && query.get("tagsFetched") === "false",
      ),
    ).toBe(true);
  });

  it("pages every affected Game into the selection", async () => {
    const requests: URLSearchParams[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input), "http://game-cat.test");
      requests.push(url.searchParams);
      const status = url.searchParams.get("tagsStatus");
      const page = Number(url.searchParams.get("page"));
      const empty: GamesResponse = {
        data: [],
        pagination: { page: 1, pageSize: 200, totalItems: 0, totalPages: 0 },
        meta: { dataAsOf: null },
      };
      let body: GamesResponse;
      if (status === "stale") {
        body = {
          data:
            page === 1
              ? Array.from({ length: 200 }, (_, index) => gameSummary(index + 1))
              : [gameSummary(201)],
          pagination: { page, pageSize: 200, totalItems: 201, totalPages: 2 },
          meta: { dataAsOf: null },
        };
      } else if (status === "missing" || status === "error") {
        body = empty;
      } else {
        throw new Error(`Unexpected request: ${url.toString()}`);
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await fetchAffectedAndPendingGames("steamspy");
    expect(result.affectedCount).toBe(201);
    expect(result.affectedIds).toHaveLength(201);
    expect(result.affectedIds[0]).toBe(1);
    expect(result.affectedIds.at(-1)).toBe(201);
    expect(
      requests.some((query) => query.get("tagsStatus") === "stale" && query.get("page") === "2"),
    ).toBe(true);
  });
});

function gameSummary(appId: number): GamesResponse["data"][number] {
  return {
    appId,
    name: `Game ${appId}`,
    ownershipStatus: "owned",
    installed: true,
    playtimeMinutes: 0,
    lastPlayedAt: null,
    releaseYear: null,
    metacriticScore: null,
    reviewScore: null,
    reviewTier: null,
    reviewCount: null,
    type: null,
    platforms: null,
    tags: [],
    metadata: { tagsStatus: "stale", storeStatus: "ok", reviewStatus: "ok" },
  };
}
