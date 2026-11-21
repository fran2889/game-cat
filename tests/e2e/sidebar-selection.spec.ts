import { expect, test, type Locator } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

let app: TestApp;

test.beforeAll(async () => {
  app = await startTestApp({ games: 3 });
});

test.afterAll(async () => {
  await app?.close();
});

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

/** The dark-6 default surface and the amber inset edge from the theme. */
const ACTIVE_BACKGROUND = "rgb(21, 24, 30)";
const ACTIVE_SHADOW = /rgb\(242, 181, 68\) 3px 0px 0px 0px inset/;

/** The stylesheet keys the active treatment on `aria-current`, so the test does too. */
async function expectActiveRow(row: Locator, name: RegExp): Promise<void> {
  await expect(row).toHaveText(name);
  await expect(row).toHaveCSS("background-color", ACTIVE_BACKGROUND);
  await expect(row).toHaveCSS("box-shadow", ACTIVE_SHADOW);
}

test("the active sidebar row uses a surface tint, accent edge, and normal text", async ({
  page,
}) => {
  await page.goto(app.url);
  const active = page.locator('.side-item[aria-current="page"]');
  await expectActiveRow(active, /All games/);
  await expect(active).toHaveCSS("color", "rgb(232, 234, 240)");

  // Selection moves with navigation and keeps aria-current.
  await page
    .locator("#sidebar")
    .getByRole("link", { name: /Installed/ })
    .click();
  await page.mouse.move(0, 0);
  await expect(page).toHaveURL(/\/installed$/);
  await expectActiveRow(page.locator('.side-item[aria-current="page"]'), /Installed/);

  // Steam Collection rows use the same treatment.
  await page
    .locator("#sidebar")
    .getByRole("link", { name: /Favorites/ })
    .click();
  await page.mouse.move(0, 0);
  await expect(page).toHaveURL(/\/steam\//);
  await expectActiveRow(page.locator('.side-item[aria-current="page"]'), /Favorites/);
});

test("the active row keeps its treatment in the mobile drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.url);
  await page.getByRole("button", { name: "Open navigation" }).click();

  const active = page.locator('.side-item[aria-current="page"]');
  await expect(active).toBeVisible();
  await expectActiveRow(active, /All games/);
});
