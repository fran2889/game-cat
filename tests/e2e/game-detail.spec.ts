import { expect, test } from "@playwright/test";
import { blockExternalRequests, seedZeroReviews, startTestApp, type TestApp } from "./fixture.ts";

let app: TestApp;

test.beforeAll(async () => {
  app = await startTestApp({ games: 130 });
  app.seedDetail(620);
  seedZeroReviews(app);
});

test.afterAll(async () => {
  await app?.close();
});

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

test("a deep link opens the detail dialog over the Library with every documented field", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${app.url}games/620`);

  const dialog = page.locator('[role="dialog"].detail-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator(".game-grid").first()).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Portal 2" })).toBeVisible();
  await expect(dialog.getByText("Installed", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Local only", { exact: true })).toBeVisible();
  await expect(dialog.getByText("10 h 12 m")).toBeVisible();
  await expect(dialog.getByText("Apr 18, 2011")).toBeVisible();
  await expect(dialog.getByText("95", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/98% · Overwhelmingly Positive · 1,000 reviews/)).toBeVisible();
  await expect(dialog.getByText("Windows, macOS")).toBeVisible();
  await expect(dialog.getByText("Action", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Single-player", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Valve", { exact: true }).first()).toBeVisible();
  await expect(dialog.locator(".tag-chip").filter({ hasText: "Puzzle" })).toContainText("31,415");
  await expect(dialog.getByText("Favorites", { exact: true })).toBeVisible();
  await expect(dialog.getByText("13.2 GB")).toBeVisible();
  await expect(dialog.getByText(/Tags:.*ok/)).toBeVisible();
  await expect(dialog.getByText(/Storefront:.*ok/)).toBeVisible();
  await expect(dialog.getByText(/Reviews:.*ok/)).toBeVisible();

  const store = dialog.getByRole("link", { name: "View on Steam Store" });
  await expect(store).toHaveAttribute("href", "https://store.steampowered.com/app/620/");

  const launch = dialog.getByRole("link", { name: "Launch" });
  await expect(launch).toHaveAttribute("href", "steam://rungameid/620");
  await launch.click();
  await expect(page.getByText("Opening Steam…")).toBeVisible();
  expect(pageErrors).toEqual([]);

  const focusInside = await page.evaluate(() => {
    const dialogElement = document.querySelector('[role="dialog"].detail-dialog');
    return dialogElement?.contains(document.activeElement) ?? false;
  });
  expect(focusInside).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".game-grid").first()).toBeVisible();
});

test("closing restores focus to the card that opened the dialog", async ({ page }) => {
  await page.goto(app.url);
  const card = page.locator(".game-card .card-open").first();
  await card.focus();
  await card.press("Enter");

  const dialog = page.locator('[role="dialog"].detail-dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".game-card .card-open").first()).toBeFocused();
});

test("clicking outside the dialog closes it and restores focus", async ({ page }) => {
  await page.goto(app.url);
  const card = page.locator(".game-card .card-open").first();
  await card.focus();
  await card.press("Enter");

  const dialog = page.locator('[role="dialog"].detail-dialog');
  await expect(dialog).toBeVisible();
  await page.mouse.click(4, 4);

  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".game-card .card-open").first()).toBeFocused();
});

test("Launch is disabled for a Game that is not installed", async ({ page }) => {
  await page.goto(`${app.url}games/570`);
  const dialog = page.locator('[role="dialog"].detail-dialog');
  await expect(dialog).toBeVisible();

  const launch = dialog.getByRole("button", { name: "Launch" });
  await expect(launch).toBeDisabled();
  await expect(launch).toHaveAttribute("title", "Install the game in Steam to launch it.");
  await expect(dialog.getByText("No user reviews", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Not available on the store")).toBeVisible();
});

test("missing detail fields use the documented copy", async ({ page }) => {
  await page.goto(`${app.url}games/730`);
  const dialog = page.locator('[role="dialog"].detail-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("No tags yet")).toBeVisible();
  await expect(dialog.getByText("Reviews unavailable", { exact: true })).toBeVisible();
  await expect(dialog.getByText("—").first()).toBeVisible();
});

test("an unknown Game shows Not found with a way back to the Library", async ({ page }) => {
  await page.goto(`${app.url}games/999999`);
  const dialog = page.locator('[role="dialog"].detail-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Not found" })).toBeVisible();
  await dialog.getByRole("link", { name: "Back to Library" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});
