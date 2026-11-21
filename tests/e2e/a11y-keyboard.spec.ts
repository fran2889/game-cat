import { expect, test, type Locator, type Page } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

/**
 * Keyboard-only jobs (§7.9, AC-U18): onboarding, Library browsing, Smart
 * Collection create/autosave, and the /errors flow. Every action here is a
 * key press; locators are only used to observe focus and assert results.
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

async function focusMain(page: Page): Promise<void> {
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
}

async function tabTo(page: Page, target: Locator, label: string, max = 160): Promise<void> {
  const first = target.first();
  for (let index = 0; index < max; index += 1) {
    await page.keyboard.press("Tab");
    const focused = await first.evaluate((element) => element === document.activeElement);
    if (focused) {
      return;
    }
  }
  throw new Error(`Tab never reached ${label}`);
}

async function selectAll(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+a");
}

test("keyboard-only onboarding saves the key and starts the first Fetch", async ({ page }) => {
  const onboarding = await startTestApp({ games: 5, noKey: true });
  try {
    await page.goto(onboarding.url);
    await expect(page).toHaveURL(/\/onboarding$/);
    // Wait for the client shell to render before sending the first Tab: the
    // URL can change before React mounts the skip link, and a Tab sent during
    // that window never reaches it.
    await expect(page.getByRole("heading", { name: "Connect your Steam library" })).toBeVisible();

    await focusMain(page);
    const key = page.getByLabel("Steam Web API key");
    await tabTo(page, key, "the Steam Web API key field");
    await page.keyboard.type("keyboard-only-key");
    await expect(key).toHaveValue("keyboard-only-key");

    await tabTo(page, page.getByRole("button", { name: "Scan library" }), "Scan library");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".game-card").first()).toBeVisible();
  } finally {
    await onboarding.close();
  }
});

test("the TopBar Tab order follows its visual order", async ({ page }) => {
  await page.goto(app.url);
  await expect(page.locator(".game-card").first()).toBeVisible();

  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: "Search game names" })).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Sort by" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sort ascending" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".toggle-button")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Grid view" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Table view" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator(".topbar-tools > .primary")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "New collection" })).toBeFocused();
});

test("the Game detail dialog traps focus and closes on Escape", async ({ page }) => {
  await page.goto(`${app.url}games/620`);
  const dialog = page.locator('[role="dialog"].detail-dialog');
  await expect(dialog.getByRole("heading", { name: "Portal 2" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close game detail" })).toBeFocused();

  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => {
        const element = document.querySelector('[role="dialog"].detail-dialog');
        return element?.contains(document.activeElement) ?? false;
      }),
      `Tab ${index + 1} left the open dialog`,
    ).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(
    await page.evaluate(() => {
      const element = document.querySelector('[role="dialog"].detail-dialog');
      return element?.contains(document.activeElement) ?? false;
    }),
  ).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
});

test("keyboard-only Library browsing: search, layout, selection, detail, and focus restore", async ({
  page,
}) => {
  await page.goto(app.url);
  await expect(page.locator(".game-card")).toHaveCount(60);

  await page.keyboard.press("/");
  const search = page.getByRole("searchbox", { name: "Search game names" });
  await expect(search).toBeFocused();
  await page.keyboard.type("portal");
  await expect(page.locator(".game-card")).toHaveCount(1);
  await expect(search).toHaveValue("portal");

  await tabTo(page, page.getByRole("button", { name: "Table view" }), "Table view");
  await page.keyboard.press("Enter");
  await expect(page.locator(".game-table")).toBeVisible();

  await tabTo(page, page.getByRole("checkbox", { name: "Select Portal 2" }), "row checkbox");
  await page.keyboard.press("Space");
  await expect(page.locator(".selection-count")).toHaveText("1 selected");

  const rowLink = page.getByRole("link", { name: /Portal 2/ });
  await tabTo(page, rowLink, "the Portal 2 row link");
  await page.keyboard.press("Enter");

  const dialog = page.locator('[role="dialog"].detail-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Portal 2" })).toBeVisible();
  const focusInside = await page.evaluate(() => {
    const element = document.querySelector('[role="dialog"].detail-dialog');
    return element?.contains(document.activeElement) ?? false;
  });
  expect(focusInside).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/[?&]q=portal/);
  await expect(rowLink).toBeFocused();
});

test("the editor rail precedes the results preview in keyboard order", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 games match · updates as you edit");

  await focusMain(page);
  // The rail sits on the right visually but comes first in the DOM, so Tab
  // lands on the Name field rather than walking the 60 preview cards.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();
});

test("keyboard-only Smart Collection create and autosave", async ({ page }) => {
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("match-count")).toHaveText("130 games match · updates as you edit");

  await focusMain(page);
  const name = page.getByRole("textbox", { name: "Name" });
  await tabTo(page, name, "the Name field");
  await selectAll(page);
  await page.keyboard.type("Keyboard created");

  // The documented shortcut creates the new Collection.
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page).toHaveURL(/\/smart\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Keyboard created");

  // A rename is autosaved without pressing Save or clicking anything.
  await tabTo(page, page.getByRole("textbox", { name: "Name" }), "the Name field again");
  await selectAll(page);
  await page.keyboard.type("Keyboard renamed");
  await expect(page.getByTestId("save-state")).toHaveText("Saved", { timeout: 10_000 });
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Keyboard renamed");

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Keyboard renamed");
});

test("keyboard-only /errors flow selects the affected Games", async ({ page }) => {
  const errors = await startTestApp({ games: 5 });
  try {
    const db = errors.server.database.raw;
    for (const appId of [620, 570, 730]) {
      db.prepare(
        `INSERT OR REPLACE INTO steamspy_appdetails (app_id, tags_status, tags_fetched_at, updated_at)
         VALUES (?, 'stale', 1, 1)`,
      ).run(appId);
    }

    await page.goto(`${errors.url}errors`);
    await expect(page.locator(".error-row")).toHaveCount(5);
    await expect(page.locator('.error-row[data-source="steamspy"]')).toContainText(
      "3 affected Games · 2 pending",
    );

    await focusMain(page);
    const selectAffected = page
      .locator('.error-row[data-source="steamspy"]')
      .getByRole("button", { name: "Select affected" });
    await tabTo(page, selectAffected, "Select affected");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(".selection-count")).toHaveText("3 selected");
  } finally {
    await errors.close();
  }
});

test("a focused grid card keeps a visible focus ring", async ({ page }) => {
  await page.goto(app.url);
  const card = page.locator(".game-card").first();
  await expect(card).toBeVisible();

  await card.locator(".card-open").focus();
  await expect(card).toHaveCSS("outline-style", "solid");
  await expect(card).toHaveCSS("outline-offset", "-2px");
});
