import { expect, test } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

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

test("grid is the default and the layout persists per view kind", async ({ page }) => {
  await page.goto(app.url);
  await expect(page.locator(".game-grid .game-card")).toHaveCount(60);
  await expect(page.locator(".game-table")).toHaveCount(0);

  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.locator(".game-table")).toBeVisible();
  await expect(page.locator(".game-card")).toHaveCount(0);
  expect(await page.evaluate(() => window.localStorage.getItem("game-cat.layout.v1.library"))).toBe(
    "table",
  );

  await page.reload();
  await expect(page.locator(".game-table")).toBeVisible();

  await page.getByRole("link", { name: /Installed/ }).click();
  await expect(page).toHaveURL(/\/installed$/);
  await expect(page.locator(".game-grid .game-card").first()).toBeVisible();
  await expect(page.locator(".game-table")).toHaveCount(0);

  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.locator(".game-table")).toBeVisible();

  await page.getByRole("link", { name: "All games" }).click();
  await expect(page.locator(".game-table")).toBeVisible();
});

test("grid cards show the documented badges, ownership, tags, and cover fallback", async ({
  page,
}) => {
  await page.goto(app.url);
  await page.getByRole("searchbox", { name: "Search game names" }).fill("portal");
  const card = page.locator(".game-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".pill-installed")).toHaveText(/Installed/);
  await expect(card.locator(".review-pill")).toHaveText("98%");
  await expect(card.locator(".game-tags")).toHaveText("Puzzle · Co-op");
  await expect(card.locator(".ownership-flag")).toHaveText("Local only");
  await expect(card.locator(".game-cover-fallback")).toHaveText("P2");
});

test("review tier and count appear on cards", async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole("searchbox", { name: "Search game names" }).fill("portal");
  const card = page.locator(".game-card");
  await expect(card).toHaveCount(1);
  await expect(card.locator(".game-review")).toHaveText("Overwhelmingly Positive · 1,000 reviews");
});

test("an unknown stored layout falls back to grid", async ({ page }) => {
  await page.goto(app.url);
  await page.evaluate(() => {
    window.localStorage.setItem("game-cat.layout.v1.library", "masonry");
  });
  await page.reload();
  await expect(page.locator(".game-grid .game-card").first()).toBeVisible();
  await expect(page.locator(".game-table")).toHaveCount(0);
});

test("the table has the documented columns, sortable headers, and null cells", async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole("button", { name: "Table view" }).click();

  const headers = page.locator(".game-table thead th");
  await expect(headers).toHaveCount(8);
  for (const label of [
    "Game",
    "Installed",
    "Playtime",
    "Last played",
    "Review",
    "Released",
    "Tags",
  ]) {
    await expect(page.getByRole("columnheader", { name: new RegExp(label) })).toBeVisible();
  }

  const gameHeader = page.getByRole("columnheader", { name: /Game/ });
  const installedHeader = page.getByRole("columnheader", { name: "Installed" });
  const playtimeHeader = page.getByRole("columnheader", { name: /Playtime/ });
  await expect(gameHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(installedHeader).not.toHaveAttribute("aria-sort");

  await playtimeHeader.getByRole("button", { name: /Sort by Playtime/ }).click();
  await expect(playtimeHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(gameHeader).toHaveAttribute("aria-sort", "none");
  await playtimeHeader.getByRole("button", { name: /Sort by Playtime/ }).click();
  await expect(playtimeHeader).toHaveAttribute("aria-sort", "descending");

  await page.getByRole("combobox", { name: "Sort by" }).selectOption("name");
  await page.getByRole("button", { name: "Sort descending" }).click();
  await expect(gameHeader).toHaveAttribute("aria-sort", "ascending");

  await page.getByRole("searchbox", { name: "Search game names" }).fill("Dota");
  const dotaRow = page.locator(".game-table tbody tr", { hasText: "Dota 2" });
  await expect(dotaRow.locator("td").nth(4)).toHaveText("—");
  await expect(dotaRow.locator("td").nth(6)).toHaveText("—");

  await page.getByRole("searchbox", { name: "Search game names" }).fill("Portal");
  const portalRow = page.locator(".game-table tbody tr", { hasText: "Portal 2" });
  await expect(portalRow.locator("td").nth(5)).toHaveText(
    "98% · Overwhelmingly Positive · 1,000 reviews",
  );
  await expect(portalRow.locator("td").nth(6)).toHaveText("2011");

  await page.getByRole("combobox", { name: "Sort by" }).selectOption("metacritic");
  await expect(gameHeader).toHaveAttribute("aria-sort", "none");
});

test("search is debounced into ?q= and survives reload, clear, and history", async ({ page }) => {
  await page.goto(app.url);
  const search = page.getByRole("searchbox", { name: "Search game names" });
  await search.fill("portal");

  await expect(page).toHaveURL(/[?&]q=portal/);
  await expect(page.locator(".game-card")).toHaveCount(1);
  await expect(page.locator(".game-card")).toContainText("Portal 2");

  await page.reload();
  await expect(page.getByRole("searchbox", { name: "Search game names" })).toHaveValue("portal");
  await expect(page.locator(".game-card")).toHaveCount(1);

  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.locator(".game-card")).toHaveCount(60);

  const searchAgain = page.getByRole("searchbox", { name: "Search game names" });
  await searchAgain.fill("portal");
  await expect(page).toHaveURL(/[?&]q=portal/);
  await page.goBack();
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.locator(".game-card")).toHaveCount(60);
  await page.goForward();
  await expect(page).toHaveURL(/[?&]q=portal/);
  await expect(page.locator(".game-card")).toHaveCount(1);
});

test("no search results uses the name-only copy and Clear search restores the list", async ({
  page,
}) => {
  await page.goto(app.url);
  await page.getByRole("searchbox", { name: "Search game names" }).fill("zzzz-no-such-game");

  await expect(page.getByText('No games match "zzzz-no-such-game".')).toBeVisible();
  await expect(
    page.getByText("Search looks at game names only. Tags, genres, and playtime belong in Rules."),
  ).toBeVisible();

  await page.locator(".empty-library").getByRole("button", { name: "Clear search" }).click();
  await expect(page.locator(".game-card")).toHaveCount(60);
});

test("the Installed toggle maps to installed=true and has no inverse filter", async ({ page }) => {
  await page.goto(app.url);
  const toggle = page.locator(".toggle-button");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".results-count")).toHaveText("44 total · 44 shown");
  await expect(page.locator(".game-card")).toHaveCount(44);

  await page.getByRole("link", { name: /Installed/ }).click();
  await expect(page.locator(".toggle-button")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".toggle-button")).toBeDisabled();
});

test("pagination requests 60 Games per page and reaches the last page", async ({ page }) => {
  await page.goto(app.url);
  await expect(page.locator(".game-card")).toHaveCount(60);
  await expect(page.getByText("Page 1 of 3")).toBeVisible();
  await expect(page.locator(".pagination-range")).toHaveText("1–60 of 130");

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Page 2 of 3")).toBeVisible();
  await expect(page.locator(".game-card")).toHaveCount(60);
  await expect(page.locator(".pagination-range")).toHaveText("61–120 of 130");

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Page 3 of 3")).toBeVisible();
  await expect(page.locator(".game-card")).toHaveCount(10);
  await expect(page.locator(".pagination-range")).toHaveText("121–130 of 130");
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();

  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.getByText("Page 1 of 3")).toBeVisible();
  await expect(page.locator(".game-table tbody tr")).toHaveCount(60);

  await page.getByRole("combobox", { name: "Sort by" }).selectOption("playtime");
  await expect(page.getByText("Page 1 of 3")).toBeVisible();
  await expect(page.locator(".pagination-range")).toHaveText("1–60 of 130");

  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("searchbox", { name: "Search game names" }).fill("a");
  await expect(page.getByText("Page 1 of 3")).toBeVisible();
  await expect(page.locator(".game-table tbody tr")).toHaveCount(60);
});

test("selection is scoped per view and New from selection hands off a prefilled draft", async ({
  page,
}) => {
  await page.goto(app.url);
  await expect(page.locator(".selection-count")).toHaveText("0 selected");
  await expect(page.getByRole("button", { name: /New from selection/ })).toBeDisabled();
  await expect(
    page.getByText("Select at least one game to create a Smart Collection."),
  ).toBeVisible();

  await page.locator(".game-card input[type=checkbox]").nth(0).check();
  await page.locator(".game-card input[type=checkbox]").nth(1).check();
  await expect(page.locator(".selection-count")).toHaveText("2 selected");
  await expect(page.getByRole("button", { name: /New from selection/ })).toBeEnabled();

  await page.getByRole("link", { name: /Installed/ }).click();
  await expect(page.locator(".selection-count")).toHaveText("0 selected");
  await page.locator(".game-card input[type=checkbox]").first().check();
  await expect(page.locator(".selection-count")).toHaveText("1 selected");

  await page.getByRole("link", { name: "All games" }).click();
  await expect(page.locator(".selection-count")).toHaveText("2 selected");

  let refreshBody: unknown = null;
  await page.route("**/api/refresh", async (route) => {
    refreshBody = route.request().postDataJSON();
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "VALIDATION_ERROR", message: "The metadata scope is unavailable." },
      }),
    });
  });
  await page.getByRole("button", { name: "Refresh selected" }).click();
  await expect(page.getByText("The metadata scope is unavailable.")).toBeVisible();
  expect(refreshBody).toMatchObject({ scope: "metadata", mode: "full" });
  expect((refreshBody as { appIds: number[] }).appIds).toHaveLength(2);

  await page.getByRole("button", { name: "+ New from selection" }).click();
  await expect(page).toHaveURL(/\/smart\/new$/);
  await expect(page.getByText("Prefilled from selection: 2 games.")).toBeVisible();
  await expect(page.getByText(/AND game in \[\.\.\.\]/)).toBeVisible();

  await page.getByRole("link", { name: "All games" }).click();
  await expect(page.locator(".selection-count")).toHaveText("0 selected");
});

test("Select shown and Clear selection use the active view's set", async ({ page }) => {
  await page.goto(app.url);
  await page.getByRole("button", { name: "Select shown" }).click();
  await expect(page.locator(".selection-count")).toHaveText("60 selected");
  await expect(page.getByRole("button", { name: "All shown selected" })).toBeDisabled();

  await page.getByRole("button", { name: "Clear selection" }).first().click();
  await expect(page.locator(".selection-count")).toHaveText("0 selected");

  await page.getByRole("button", { name: "Table view" }).click();
  await page.getByLabel("Select all shown games").check();
  await expect(page.locator(".selection-count")).toHaveText("60 selected");
});

test("a narrow table scrolls inside its container without a page scrollbar", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("game-cat.layout.v1.library", "table");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.url);
  await expect(page.locator(".game-table")).toBeVisible();

  const metrics = await page.evaluate(() => {
    const wrap = document.querySelector(".table-wrap");
    return {
      pageWidth: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      wrapScrollWidth: wrap?.scrollWidth ?? 0,
      wrapClientWidth: wrap?.clientWidth ?? 0,
    };
  });
  expect(metrics.pageWidth).toBeLessThanOrEqual(metrics.viewport);
  expect(metrics.wrapScrollWidth).toBeGreaterThan(metrics.wrapClientWidth);
});
