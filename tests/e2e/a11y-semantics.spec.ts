import { expect, test, type Locator, type Page } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

/**
 * Semantics and state-announcement checks (§7.9, AC-U18): table headers,
 * accessible names, live regions, reduced motion, and the mobile drawer.
 */

let app: TestApp;

test.beforeAll(async () => {
  app = await startTestApp({ games: 130 });
  app.seedDetail(620);
});

test.afterAll(async () => {
  await app?.close();
});

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

async function tabTo(page: Page, target: Locator, label: string, max = 160): Promise<void> {
  const first = target.first();
  for (let index = 0; index < max; index += 1) {
    await page.keyboard.press("Tab");
    if (await first.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }
  throw new Error(`Tab never reached ${label}`);
}

function insertRunningRun(app: TestApp): void {
  const now = Math.floor(Date.now() / 1_000);
  app.server.database.raw
    .prepare(
      `INSERT INTO refresh_runs (
         scope, mode, status, started_at, finished_at, total, done,
         app_ids_json, error_code, error_message, stats_json
       ) VALUES ('all', 'fetch', 'running', ?, NULL, NULL, 0, NULL, NULL, NULL, ?)`,
    )
    .run(now, JSON.stringify({ sources: {}, lastProgressAt: now }));
}

test("table headers expose scope and aria-sort, and every icon-only control is named", async ({
  page,
}) => {
  await page.goto(app.url);
  await expect(page.getByRole("searchbox", { name: "Search game names" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Table view" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort ascending" })).toBeVisible();
  await expect(page.locator(".search-wrap kbd")).toHaveAttribute("aria-hidden", "true");

  await page.getByRole("button", { name: "Table view" }).click();
  const headers = page.locator(".game-table thead th");
  await expect(headers).toHaveCount(8);
  const scopes = await headers.evaluateAll((cells) =>
    cells.map((cell) => cell.getAttribute("scope")),
  );
  expect(scopes).toEqual(Array(8).fill("col"));

  await expect(page.getByRole("columnheader", { name: /Game/ })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await expect(page.getByRole("columnheader", { name: /Playtime/ })).toHaveAttribute(
    "aria-sort",
    "none",
  );
  await expect(page.getByRole("columnheader", { name: "Installed" })).not.toHaveAttribute(
    "aria-sort",
  );

  await page.goto(`${app.url}smart/new`);
  await page.getByRole("button", { name: "Game list" }).click();
  await expect(page.getByRole("button", { name: "Remove rule 1" })).toBeVisible();
  await page.getByRole("button", { name: "Add rule" }).click();
  await expect(page.getByRole("button", { name: "Remove rule 2" })).toBeVisible();

  await page.goto(`${app.url}games/620`);
  await expect(page.getByRole("button", { name: "Close game detail" })).toBeVisible();
});

test("the TopBar search only appears on views that use it", async ({ page }) => {
  await page.goto(app.url);
  await expect(page.getByRole("searchbox", { name: "Search game names" })).toHaveCount(1);

  await page.goto(`${app.url}installed`);
  await expect(page.getByRole("searchbox", { name: "Search game names" })).toHaveCount(1);

  for (const route of ["smart/new", "errors", "settings", "steam/favorite"]) {
    await page.goto(`${app.url}${route}`);
    await expect(
      page.getByRole("searchbox", { name: "Search game names" }),
      `${route} must not render a search box that does nothing`,
    ).toHaveCount(0);
  }
});

test("match counts, Refresh progress, and toasts are announced politely", async ({ page }) => {
  await page.goto(app.url);
  await expect(page.locator(".results-count")).toHaveAttribute("aria-live", "polite");

  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveAttribute("aria-live", "polite");

  await page.goto(`${app.url}games/620`);
  await expect(page.getByRole("heading", { name: "Portal 2" })).toBeVisible();
  await page.getByRole("link", { name: "Launch" }).click();
  await expect(page.locator(".toast-root")).toHaveAttribute("aria-live", "polite");
  await expect(page.locator(".toast")).toHaveAttribute("role", "status");
  await expect(page.getByText("Opening Steam…")).toBeVisible();

  insertRunningRun(app);
  await page.goto(app.url);
  const banner = page.locator(".refresh-running");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("aria-live", "polite");
  const progress = page.getByRole("progressbar", { name: /Fetch progress/ });
  await expect(progress).toBeVisible();
  await expect(progress).toHaveAttribute("aria-valuemin", "0");
});

test("status is never colour-only: every status pill carries text", async ({ page }) => {
  await page.goto(`${app.url}errors`);
  await expect(page.locator(".error-row")).toHaveCount(5);
  const pills = page.locator(".status-pill");
  expect(await pills.count()).toBeGreaterThan(0);
  for (let index = 0; index < (await pills.count()); index += 1) {
    expect((await pills.nth(index).innerText()).trim()).not.toBe("");
  }

  await page.goto(app.url);
  await expect(page.locator(".pill-installed").first()).toContainText("Installed");
  await expect(page.locator(".status-card strong")).not.toBeEmpty();
});

test("prefers-reduced-motion makes progress and skeleton animations static", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  insertRunningRun(app);
  await page.goto(app.url);
  const sweep = page.locator(".progress-indeterminate > span");
  await expect(sweep).toBeAttached();
  const progressStyle = await sweep.evaluate((element) => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, transform: style.transform };
  });
  expect(progressStyle.animationName).toBe("none");
  expect(progressStyle.transform).toBe("none");

  await page.route("**/api/games?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    await route.continue();
  });
  await page.goto(app.url);
  const skeleton = page.locator(".skeleton-cover").first();
  await expect(skeleton).toBeVisible();
  const skeletonStyle = await skeleton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, animationDuration: style.animationDuration };
  });
  expect(skeletonStyle.animationName).toBe("none");
});

test.describe("390 px sidebar drawer", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("opens from the keyboard, contains focus, closes on Escape, and restores focus", async ({
    page,
  }) => {
    await page.goto(app.url);
    const menu = page.getByRole("button", { name: "Open navigation" });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toHaveAttribute("aria-controls", "sidebar");

    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await tabTo(page, menu, "Open navigation");
    await page.keyboard.press("Enter");

    const sidebar = page.locator("#sidebar");
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar).toHaveClass(/is-open/);
    await expect(page.getByRole("button", { name: "Close navigation" })).toBeFocused();

    // The drawer is the only focus region while open.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: /All games/ })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(sidebar).not.toHaveClass(/is-open/);
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeFocused();

    const closed = await sidebar.evaluate((element) => {
      const style = getComputedStyle(element);
      return { visibility: style.visibility, transform: style.transform };
    });
    expect(closed.visibility).toBe("hidden");
    expect(closed.transform).not.toBe("none");
  });
});
