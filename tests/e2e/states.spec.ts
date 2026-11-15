import { expect, test } from "@playwright/test";
import { blockExternalRequests, startTestApp } from "./fixture.ts";

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

test("the initial load shows an aria-busy skeleton", async ({ page }) => {
  const app = await startTestApp({ games: 10 });
  try {
    await page.route("**/api/games?*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    await page.goto(app.url);
    await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test("an empty Library renders No games found with recovery actions", async ({ page }) => {
  const app = await startTestApp({ empty: true, steamCollection: false });
  try {
    await page.goto(app.url);
    await expect(page.getByRole("heading", { name: "No games found." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Change Steam folder" })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("no Account keeps local Games usable and explains the warning", async ({ page }) => {
  const app = await startTestApp({ games: 10, account: false });
  try {
    await page.goto(app.url);
    await expect(page.getByText("No Steam Account selected.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open account picker" })).toBeVisible();
    await expect(page.locator(".game-card").first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test("a missing Steam root renders the Steam-not-found state", async ({ page }) => {
  const app = await startTestApp({ steamMissing: true });
  try {
    await page.goto(app.url);
    await expect(page.getByRole("heading", { name: "Steam was not found." })).toBeVisible();
    await expect(page.getByText(/Configured Steam folder:/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible();
  } finally {
    await app.close();
  }
});

test("an unknown route renders Not found with a Link back to the Library", async ({ page }) => {
  const app = await startTestApp({ games: 5 });
  try {
    await page.goto(`${app.url}not-a-real-route`);
    await expect(page.getByRole("heading", { name: "Not found", level: 2 })).toBeVisible();
    await page.getByRole("link", { name: "Back to Library" }).click();
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await app.close();
  }
});

test("a disconnected server shows the retry banner", async ({ page }) => {
  const app = await startTestApp({ games: 10 });
  try {
    await page.goto(app.url);
    await expect(page.locator(".game-card").first()).toBeVisible();
    await app.close();
    await page.getByRole("link", { name: /Installed/ }).click();
    await expect(
      page.getByText("Cannot reach game-cat. Is the server still running?").first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry connection" })).toBeVisible();
  } finally {
    await app.close();
  }
});
