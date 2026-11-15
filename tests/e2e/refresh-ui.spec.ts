import { expect, test } from "@playwright/test";
import type { MetadataSource, MetadataSourceOutcome } from "../../src/server/refresh/sources.ts";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

/**
 * Refresh UI and `/errors` (§7.7, AC-U15-U17). Every run and source here is
 * seeded or injected; no test reaches a real upstream host.
 */

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

function fakeSources(): MetadataSource[] {
  return (["steamspy", "storefront", "steam_reviews"] as const).map((name) => ({
    name,
    async fetch(): Promise<MetadataSourceOutcome> {
      return { kind: "ok" };
    },
  }));
}

interface RunSeed {
  scope: "library" | "ownership" | "metadata" | "all";
  mode: "fetch" | "full" | null;
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  startedAt: number;
  finishedAt?: number | null;
  total?: number | null;
  done?: number;
  appIds?: number[] | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  stats?: {
    sources: Record<
      "steamspy" | "storefront" | "steam_reviews",
      { candidates: number; done: number; failed: number; skipped: number }
    >;
  } | null;
}

function insertRun(app: TestApp, seed: RunSeed): number {
  const stats =
    seed.stats === undefined || seed.stats === null
      ? null
      : JSON.stringify({ ...seed.stats, lastProgressAt: seed.startedAt });
  const info = app.server.database.raw
    .prepare(
      `INSERT INTO refresh_runs (
         scope, mode, status, started_at, finished_at, total, done,
         app_ids_json, error_code, error_message, stats_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.scope,
      seed.mode,
      seed.status,
      seed.startedAt,
      seed.finishedAt ?? null,
      seed.total ?? null,
      seed.done ?? 0,
      seed.appIds === undefined || seed.appIds === null ? null : JSON.stringify(seed.appIds),
      seed.errorCode ?? null,
      seed.errorMessage ?? null,
      stats,
    );
  return Number(info.lastInsertRowid);
}

function completeRun(app: TestApp, id: number): void {
  app.server.database.raw
    .prepare(
      `UPDATE refresh_runs SET status = 'succeeded', finished_at = ?,
         done = COALESCE(total, done), error_code = NULL, error_message = NULL
       WHERE id = ?`,
    )
    .run(Math.floor(Date.now() / 1_000), id);
}

interface StatusSeed {
  appId: number;
  status: string;
  fetchedAt?: number | null;
}

function seedMetadata(
  app: TestApp,
  source: "steamspy" | "storefront" | "steam_reviews",
  entries: StatusSeed[],
): void {
  const sql: Record<typeof source, string> = {
    steamspy: `INSERT INTO steamspy_appdetails (app_id, tags_status, tags_fetched_at, updated_at)
              VALUES (?, ?, ?, 1)
              ON CONFLICT(app_id) DO UPDATE SET
                tags_status = excluded.tags_status,
                tags_fetched_at = excluded.tags_fetched_at`,
    storefront: `INSERT INTO storefront_appdetails (app_id, store_status, store_fetched_at, updated_at)
                 VALUES (?, ?, ?, 1)
                 ON CONFLICT(app_id) DO UPDATE SET
                   store_status = excluded.store_status,
                   store_fetched_at = excluded.store_fetched_at`,
    steam_reviews: `INSERT INTO steam_review_summaries (app_id, review_status, review_fetched_at, updated_at)
                    VALUES (?, ?, ?, 1)
                    ON CONFLICT(app_id) DO UPDATE SET
                      review_status = excluded.review_status,
                      review_fetched_at = excluded.review_fetched_at`,
  };
  const statement = app.server.database.raw.prepare(sql[source]);
  for (const entry of entries) {
    statement.run(entry.appId, entry.status, entry.fetchedAt === undefined ? 1 : entry.fetchedAt);
  }
}

function latestRun(
  app: TestApp,
): { id: number; scope: string; mode: string | null; app_ids_json: string | null } | undefined {
  return app.server.database.raw
    .prepare("SELECT id, scope, mode, app_ids_json FROM refresh_runs ORDER BY id DESC LIMIT 1")
    .get() as
    { id: number; scope: string; mode: string | null; app_ids_json: string | null } | undefined;
}

const NOW = (): number => Math.floor(Date.now() / 1_000);

const runningStats = {
  sources: {
    steamspy: { candidates: 120, done: 100, failed: 0, skipped: 15 },
    storefront: { candidates: 120, done: 90, failed: 0, skipped: 20 },
    steam_reviews: { candidates: 120, done: 80, failed: 0, skipped: 30 },
  },
};

test("Fetch is disabled while active and the banner shows progress and usable copy", async ({
  page,
}) => {
  const app = await startTestApp({ games: 10, metadataSources: fakeSources() });
  try {
    insertRun(app, {
      scope: "all",
      mode: "fetch",
      status: "running",
      startedAt: NOW() - 30,
      total: 1300,
      done: 120,
      stats: runningStats,
    });
    await page.goto(app.url);

    await expect(page.locator(".topbar").getByRole("button", { name: "Fetch" })).toBeDisabled();
    await expect(page.locator(".sidebar").getByRole("button", { name: "Fetch" })).toBeDisabled();

    const banner = page.locator(".refresh-running");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Fetch");
    await expect(banner.locator(".refresh-phase")).toHaveText("metadata");
    await expect(banner).toContainText("120 of 1,300");
    await expect(banner).toContainText("SteamSpy");
    await expect(banner).toContainText("100/120");
    await expect(banner).toContainText("15 skipped");
    await expect(banner).toContainText("The Library stays usable while this runs.");
    await expect(banner.getByRole("link", { name: "View refresh errors" })).toHaveAttribute(
      "href",
      "/errors",
    );
    await expect(banner.getByRole("button", { name: /cancel/i })).toHaveCount(0);

    // The cached Library remains usable while the run is active.
    await expect(page.locator(".game-card").first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a succeeded run clears the banner and shows the Library up to date toast", async ({
  page,
}) => {
  const app = await startTestApp({ games: 10, metadataSources: fakeSources() });
  try {
    const id = insertRun(app, {
      scope: "all",
      mode: "fetch",
      status: "running",
      startedAt: NOW() - 30,
      total: 10,
      done: 4,
      stats: runningStats,
    });
    await page.goto(app.url);
    await expect(page.locator(".refresh-running")).toBeVisible();

    completeRun(app, id);

    await expect(page.locator(".toast").getByText("Library up to date")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator(".refresh-running")).toHaveCount(0);
    await expect(page.locator(".status-card")).toContainText("Library up to date");
  } finally {
    await app.close();
  }
});

test("the primary Fetch sends all + Fetch", async ({ page }) => {
  const app = await startTestApp({ games: 10, metadataSources: fakeSources() });
  try {
    await page.goto(app.url);
    const before = latestRun(app)?.id ?? 0;
    await page.locator(".topbar").getByRole("button", { name: "Fetch" }).click();

    await expect.poll(() => latestRun(app)?.id ?? 0, { timeout: 5_000 }).toBeGreaterThan(before);
    expect(latestRun(app)).toMatchObject({ scope: "all", mode: "fetch" });
  } finally {
    await app.close();
  }
});

test("a partial run with an error keeps the run error, View refresh errors, and Retry", async ({
  page,
}) => {
  const app = await startTestApp({ games: 5, metadataSources: fakeSources() });
  try {
    insertRun(app, {
      scope: "all",
      mode: "fetch",
      status: "partial",
      startedAt: NOW() - 60,
      finishedAt: NOW() - 20,
      total: 5,
      done: 5,
      errorCode: "OWNERSHIP_NOT_CONFIGURED",
      errorMessage: "Ownership was skipped because the Steam Web API key is not configured.",
    });
    await page.goto(app.url);

    const banner = page.locator(".refresh-banner");
    await expect(banner).toContainText("Fetch finished with some work incomplete.");
    await expect(banner).toContainText("OWNERSHIP_NOT_CONFIGURED");
    await expect(banner).toContainText("Ownership was skipped");
    await expect(banner.getByRole("link", { name: "View refresh errors" })).toBeVisible();
    await expect(banner.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.locator(".game-card").first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a partial run with error null uses the generic failure copy", async ({ page }) => {
  const app = await startTestApp({ games: 5, metadataSources: fakeSources() });
  try {
    insertRun(app, {
      scope: "metadata",
      mode: "fetch",
      status: "partial",
      startedAt: NOW() - 60,
      finishedAt: NOW() - 20,
      total: 5,
      done: 5,
    });
    await page.goto(app.url);

    await expect(
      page
        .locator(".refresh-banner")
        .getByText("Fetch finished with some work incomplete.")
        .first(),
    ).toBeVisible();
    await expect(
      page.locator(".refresh-banner").getByRole("button", { name: "Retry" }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a failed run shows the run error and Retry, and INTERRUPTED explains resumption", async ({
  page,
}) => {
  const app = await startTestApp({ games: 5, metadataSources: fakeSources() });
  try {
    const id = insertRun(app, {
      scope: "metadata",
      mode: "fetch",
      status: "failed",
      startedAt: NOW() - 60,
      finishedAt: NOW() - 20,
      errorCode: "INTERNAL_ERROR",
      errorMessage: "The Refresh run failed while writing progress.",
    });
    await page.goto(app.url);

    const banner = page.locator(".refresh-banner");
    await expect(banner).toContainText("Fetch failed");
    await expect(banner).toContainText("INTERNAL_ERROR");
    await expect(banner).toContainText("The Refresh run failed while writing progress.");
    await expect(banner.getByRole("link", { name: "View refresh errors" })).toBeVisible();
    await expect(banner.getByRole("button", { name: "Retry" })).toBeVisible();

    app.server.database.raw
      .prepare("UPDATE refresh_runs SET error_code = 'INTERRUPTED', error_message = ? WHERE id = ?")
      .run("The Refresh run was interrupted. The next Fetch resumes pending work.", id);
    await page.reload();
    await expect(page.locator(".refresh-banner")).toContainText("INTERRUPTED");
    await expect(page.locator(".refresh-banner")).toContainText(
      "The next Fetch resumes pending work.",
    );
  } finally {
    await app.close();
  }
});

test("ownership failure shows counts and actions, and Retry sends ownership", async ({ page }) => {
  const app = await startTestApp({ games: 5, metadataSources: fakeSources() });
  try {
    app.server.database.raw
      .prepare(
        "UPDATE source_state SET status = 'invalid_key', last_error = ? WHERE name = 'steam_web_api'",
      )
      .run("Steam rejected the Web API key.");
    await page.goto(app.url);

    await expect(page.locator(".status-card")).toContainText("Ownership incomplete");
    const banner = page.locator(".banner").filter({ hasText: "Ownership incomplete" }).first();
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/Owned \d+ · Local only \d+ · Unknown \d+/);
    await expect(banner.getByRole("link", { name: "View refresh errors" })).toBeVisible();
    await expect(banner.getByRole("link", { name: "Fix API key" })).toHaveAttribute(
      "href",
      "/onboarding",
    );

    const before = latestRun(app)?.id ?? 0;
    await banner.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => latestRun(app)?.id ?? 0, { timeout: 5_000 }).toBeGreaterThan(before);
    expect(latestRun(app)).toMatchObject({ scope: "ownership", mode: null });
  } finally {
    await app.close();
  }
});

test("/errors lists five source rows in order with health, backoff, and safe errors", async ({
  page,
}) => {
  const app = await startTestApp({ games: 5, metadataSources: fakeSources() });
  try {
    const db = app.server.database.raw;
    const at = NOW();
    db.prepare(
      `UPDATE source_state SET status = 'ok', last_success_at = ?, last_attempt_at = ?, last_error = NULL
       WHERE name = 'steam_local'`,
    ).run(at, at);
    db.prepare(
      `UPDATE source_state SET status = 'invalid_key', last_attempt_at = ?, last_error = ?
       WHERE name = 'steam_web_api'`,
    ).run(at, "Steam rejected the Web API key.");
    db.prepare(
      `UPDATE source_state SET status = 'rate_limited', last_attempt_at = ?, retry_after_at = ?, last_error = ?
       WHERE name = 'steamspy'`,
    ).run(at, at + 300, "SteamSpy is rate limited.");
    db.prepare(
      `UPDATE source_state SET status = 'error', last_attempt_at = ?, last_error = ?
       WHERE name = 'storefront'`,
    ).run(at, "The store returned malformed JSON.");
    db.prepare(
      `UPDATE source_state SET status = 'ok', last_success_at = ?, last_attempt_at = ?, last_error = NULL
       WHERE name = 'steam_reviews'`,
    ).run(at, at);

    seedMetadata(app, "steamspy", [
      { appId: 620, status: "missing", fetchedAt: null },
      { appId: 570, status: "stale" },
      { appId: 730, status: "error" },
      { appId: 1004, status: "ok" },
      { appId: 1005, status: "ok" },
    ]);
    seedMetadata(app, "storefront", [
      { appId: 620, status: "error" },
      { appId: 570, status: "missing", fetchedAt: null },
      { appId: 730, status: "stale" },
      { appId: 1004, status: "unavailable" },
      { appId: 1005, status: "ok" },
    ]);
    seedMetadata(app, "steam_reviews", [
      { appId: 620, status: "unavailable" },
      { appId: 570, status: "ok" },
      { appId: 730, status: "missing", fetchedAt: null },
      { appId: 1004, status: "ok" },
      { appId: 1005, status: "ok" },
    ]);
    db.prepare("UPDATE storefront_appdetails SET store_error = 'RAW_UPSTREAM_BODY_XYZ'").run();

    await page.goto(`${app.url}errors`);

    const rows = page.locator(".error-row");
    await expect(rows).toHaveCount(5);
    const order: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      order.push((await rows.nth(index).getAttribute("data-source")) ?? "");
    }
    expect(order).toEqual([
      "steam_local",
      "steam_web_api",
      "steamspy",
      "storefront",
      "steam_reviews",
    ]);

    const steamspy = page.locator('.error-row[data-source="steamspy"]');
    await expect(steamspy).toContainText("rate_limited");
    await expect(steamspy).toContainText("Last success");
    await expect(steamspy).toContainText("Last attempt");
    await expect(steamspy).toContainText("Retry after");
    await expect(steamspy).toContainText("SteamSpy is rate limited.");
    await expect(steamspy).toContainText("3 affected Games");
    await expect(steamspy.getByRole("button", { name: "Fetch now" })).toBeVisible();
    await expect(steamspy.getByRole("button", { name: "Select affected" })).toBeEnabled();

    await expect(page.locator('.error-row[data-source="steam_local"]')).not.toContainText(
      "Fetch now",
    );
    await expect(page.locator('.error-row[data-source="storefront"]')).toContainText(
      "The store returned malformed JSON.",
    );
    await expect(page.locator('.error-row[data-source="storefront"]')).toContainText(
      "3 affected Games",
    );

    // No per-Game error text or raw payload ever crosses this surface.
    await expect(page.locator("body")).not.toContainText("RAW_UPSTREAM_BODY_XYZ");
  } finally {
    await app.close();
  }
});

test("Select affected excludes ok/unavailable and Refresh selected sends metadata + full", async ({
  page,
}) => {
  const app = await startTestApp({ games: 5, metadataSources: fakeSources() });
  try {
    seedMetadata(app, "steamspy", [
      { appId: 620, status: "missing", fetchedAt: null },
      { appId: 570, status: "stale" },
      { appId: 730, status: "error" },
      { appId: 1004, status: "ok" },
      { appId: 1005, status: "ok" },
    ]);

    await page.goto(`${app.url}errors`);
    const steamspy = page.locator('.error-row[data-source="steamspy"]');
    await expect(steamspy).toContainText("3 affected Games");
    await steamspy.getByRole("button", { name: "Select affected" }).click();

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".selection-count")).toHaveText("3 selected");
    await expect(page.locator(".game-card.is-selected")).toHaveCount(3);

    const before = latestRun(app)?.id ?? 0;
    await page.getByRole("button", { name: "Refresh selected" }).click();
    await expect.poll(() => latestRun(app)?.id ?? 0, { timeout: 5_000 }).toBeGreaterThan(before);
    const run = latestRun(app);
    expect(run).toMatchObject({ scope: "metadata", mode: "full" });
    expect(JSON.parse(run?.app_ids_json ?? "[]")).toEqual([570, 620, 730]);
  } finally {
    await app.close();
  }
});

test("Fetch now on the errors view sends all + Fetch", async ({ page }) => {
  const app = await startTestApp({ games: 5, metadataSources: fakeSources() });
  try {
    await page.goto(`${app.url}errors`);
    const before = latestRun(app)?.id ?? 0;
    await page
      .locator('.error-row[data-source="steamspy"]')
      .getByRole("button", { name: "Fetch now" })
      .click();

    await expect.poll(() => latestRun(app)?.id ?? 0, { timeout: 5_000 }).toBeGreaterThan(before);
    expect(latestRun(app)).toMatchObject({ scope: "all", mode: "fetch" });
  } finally {
    await app.close();
  }
});
