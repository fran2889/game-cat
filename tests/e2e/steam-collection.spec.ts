import { expect, test } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

let app: TestApp;

test.beforeAll(async () => {
  app = await startTestApp({ games: 10, steamCollection: true });
});

test.afterAll(async () => {
  await app?.close();
});

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

test("the Steam Collection view reuses the shared grid, table, and selection", async ({ page }) => {
  await page.goto(`${app.url}steam/favorite`);
  await expect(page.getByRole("heading", { name: "Favorites" })).toBeVisible();
  await expect(page.locator(".game-card")).toHaveCount(2);

  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.locator(".game-table tbody tr")).toHaveCount(2);
  expect(await page.evaluate(() => window.localStorage.getItem("game-cat.layout.v1.steam"))).toBe(
    "table",
  );

  await page.reload();
  await expect(page.locator(".game-table tbody tr")).toHaveCount(2);

  await page.getByRole("link", { name: "All games" }).click();
  await expect(page.locator(".game-grid .game-card").first()).toBeVisible();

  await page.getByRole("link", { name: /Favorites/ }).click();
  await expect(page.locator(".game-table tbody tr")).toHaveCount(2);
  await page.locator(".game-table tbody input[type=checkbox]").first().check();
  await expect(page.locator(".selection-count")).toHaveText("1 selected");

  await page.getByRole("link", { name: "All games" }).click();
  await expect(page.locator(".selection-count")).toHaveText("0 selected");
});
