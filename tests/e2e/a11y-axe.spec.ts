import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, expectNoSeriousA11yViolations } from "./a11y.ts";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

/**
 * Automated WCAG 2.2 AA checks (§7.9, AC-U18-U19). Every screen visits the
 * real client against the real server fixture. Screens wait for their settled
 * state first so axe does not evaluate a transient skeleton.
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

test("Library grid and table have no serious axe violations", async ({ page }) => {
  await page.goto(app.url);
  await expect(page.locator(".game-card")).toHaveCount(60);
  await expectNoSeriousA11yViolations(page, "Library grid");

  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.locator(".game-table tbody tr")).toHaveCount(60);
  await expectNoSeriousA11yViolations(page, "Library table");
});

test("the Smart Collection editor and Game picker have no serious axe violations", async ({
  page,
}) => {
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");
  await expectNoSeriousA11yViolations(page, "Smart Collection editor");

  await page.getByRole("button", { name: "Game list" }).click();
  await expect(page.getByRole("searchbox", { name: "Search Games for this Rule" })).toBeVisible();
  await expectNoSeriousA11yViolations(page, "Game picker");
});

test("a saved Smart Collection editor has no serious axe violations", async ({ page }) => {
  const created = await page.request.post(`${app.url}api/smart-collections`, {
    data: { name: "Axe saved collection", rules: [] },
  });
  expect(created.status()).toBe(201);
  const body = (await created.json()) as { data: { id: string } };

  await page.goto(`${app.url}smart/${body.data.id}`);
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");
  await expectNoSeriousA11yViolations(page, "Saved Smart Collection editor");
});

test("the Smart Collection leave dialog has no serious axe violations", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 matches");
  await page.getByRole("textbox", { name: "Name" }).fill("Axe unsaved draft");
  await page.getByRole("link", { name: "All games" }).click();

  const dialog = page.getByRole("alertdialog", { name: "Leave with unsaved changes" });
  await expect(dialog).toBeVisible();
  await expectNoSeriousA11yViolations(page, "Smart Collection leave dialog");
});

test("the Game detail dialog has no serious axe violations", async ({ page }) => {
  await page.goto(`${app.url}games/620`);
  const dialog = page.locator('[role="dialog"].detail-dialog');
  await expect(dialog.getByRole("heading", { name: "Portal 2" })).toBeVisible();
  await expectNoSeriousA11yViolations(page, "Game detail dialog");
});

test("onboarding has no serious axe violations", async ({ page }) => {
  const onboarding = await startTestApp({ games: 5, noKey: true });
  try {
    await page.goto(onboarding.url);
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Connect your Steam library" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Onboarding");
  } finally {
    await onboarding.close();
  }
});

test("/errors has no serious axe violations", async ({ page }) => {
  await page.goto(`${app.url}errors`);
  await expect(page.getByRole("heading", { name: "Refresh errors", level: 2 })).toBeVisible();
  await expect(page.locator(".error-row")).toHaveCount(5);
  await expectNoSeriousA11yViolations(page, "Refresh errors");
});

test.describe("390 px layouts", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Library grid and table fit without page scroll", async ({ page }) => {
    await page.goto(app.url);
    await expect(page.locator(".game-card").first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "Library grid at 390 px");

    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.locator("#sidebar")).toHaveClass(/is-open/);
    await expectNoSeriousA11yViolations(page, "open sidebar drawer at 390 px");
    await page.keyboard.press("Escape");
    await expect(page.locator("#sidebar")).not.toHaveClass(/is-open/);

    await page.addInitScript(() => {
      window.localStorage.setItem("game-cat.layout.v1.library", "table");
    });
    await page.reload();
    await expect(page.locator(".game-table")).toBeVisible();
    await expectNoHorizontalScroll(page);
    const tableScrolls = await page.evaluate(() => {
      const wrap = document.querySelector(".table-wrap");
      return (wrap?.scrollWidth ?? 0) > (wrap?.clientWidth ?? 0);
    });
    expect(tableScrolls).toBe(true);
    await expectNoSeriousA11yViolations(page, "Library table at 390 px");
  });

  test("the editor, detail dialog, onboarding, and /errors fit without page scroll", async ({
    page,
  }) => {
    await page.goto(`${app.url}smart/new`);
    await expect(page.getByTestId("match-count")).toHaveText("130 matches");
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "editor at 390 px");

    await page.getByRole("button", { name: "Game list" }).click();
    await expect(page.getByRole("searchbox", { name: "Search Games for this Rule" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "Game picker at 390 px");

    await page.goto(`${app.url}games/620`);
    await expect(page.getByRole("heading", { name: "Portal 2" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "detail dialog at 390 px");

    await page.goto(`${app.url}errors`);
    await expect(page.locator(".error-row")).toHaveCount(5);
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "/errors at 390 px");

    await page.goto(`${app.url}steam/favorite`);
    await expect(page.getByRole("heading", { name: "Favorites" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "Steam Collection at 390 px");

    await page.goto(`${app.url}settings`);
    await expect(page.getByRole("heading", { name: "Configuration" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "settings at 390 px");

    const onboarding = await startTestApp({ games: 5, noKey: true });
    try {
      await page.goto(onboarding.url);
      await expect(page.getByRole("heading", { name: "Connect your Steam library" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, "onboarding at 390 px");
    } finally {
      await onboarding.close();
    }
  });
});
