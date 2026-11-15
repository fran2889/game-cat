import { describe, expect, it } from "vitest";
import type { RefreshRun, Status } from "../../src/shared/types.ts";
import {
  affectedStatuses,
  dataAsOf,
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
    steam: { state: "ready", root: "/steam", account: null },
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
    expect(affectedStatuses()).toEqual(["missing", "stale", "error"]);
    expect(affectedStatuses()).not.toContain("ok");
    expect(affectedStatuses()).not.toContain("unavailable");
  });
});
