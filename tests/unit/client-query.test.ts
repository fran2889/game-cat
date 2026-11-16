import { describe, expect, it, vi } from "vitest";
import { statusRefetchInterval, STATUS_POLL_INTERVAL_MS } from "../../src/client/api.ts";
import { createQueryClient } from "../../src/client/query-client.ts";
import type { Status } from "../../src/shared/types.ts";

function statusWith(activeRefresh: Status["activeRefresh"]): Status {
  return {
    activeRefresh,
    lastRefresh: null,
  } as Status;
}

const runningRun = {
  id: "4",
  scope: "all",
  mode: "fetch",
  status: "running",
  startedAt: "2026-11-16T10:00:00Z",
  finishedAt: null,
  total: null,
  done: 0,
  appIds: null,
  stats: null,
  error: null,
} as const;

describe("Status polling", () => {
  it("polls at 800 ms only while a Refresh run is active", () => {
    expect(STATUS_POLL_INTERVAL_MS).toBe(800);
    expect(statusRefetchInterval(undefined)).toBe(false);
    expect(statusRefetchInterval(null)).toBe(false);
    expect(statusRefetchInterval(statusWith(null))).toBe(false);
    expect(statusRefetchInterval(statusWith(runningRun))).toBe(800);
  });
});

describe("Query client defaults", () => {
  it("does not retry a failed read or refetch on focus behind the user's back", () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions().queries;
    expect(defaults?.retry).toBe(false);
    expect(defaults?.refetchOnWindowFocus).toBe(false);
    expect(defaults?.refetchOnReconnect).toBe(false);
  });

  it("deduplicates concurrent reads with the same key into one request", async () => {
    const client = createQueryClient();
    let resolve: ((value: string) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );

    const first = client.fetchQuery({ queryKey: ["games", { page: 1 }], queryFn: request });
    const second = client.fetchQuery({ queryKey: ["games", { page: 1 }], queryFn: request });

    expect(request).toHaveBeenCalledTimes(1);
    resolve?.("games");
    await expect(Promise.all([first, second])).resolves.toEqual(["games", "games"]);
  });
});
