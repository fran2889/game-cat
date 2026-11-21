import { expect, test } from "@playwright/test";
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

test("the active sidebar row uses a surface tint, accent edge, and normal text", async ({
  page,
}) => {
  await page.goto(app.url);
  const active = page.locator('.side-item[aria-current="page"]');
  await expect(active).toHaveText(/All games/);

  await expect(active).toHaveCSS("background-color", "rgb(21, 24, 30)");
  await expect(active).toHaveCSS("color", "rgb(232, 234, 240)");
  await expect(active).toHaveCSS("box-shadow", /rgb\(242, 181, 68\) 3px 0px 0px 0px inset/);

  // Selection moves with navigation and keeps aria-current.
  await page
    .locator("#sidebar")
    .getByRole("link", { name: /Installed/ })
    .click();
  await page.mouse.move(0, 0);
  await expect(page).toHaveURL(/\/installed$/);
  const installed = page.locator('.side-item[aria-current="page"]');
  await expect(installed).toHaveText(/Installed/);
  await expect(installed).toHaveCSS("background-color", "rgb(21, 24, 30)");
  await expect(installed).toHaveCSS("box-shadow", /rgb\(242, 181, 68\) 3px 0px 0px 0px inset/);

  // Steam Collection rows use the same treatment.
  await page
    .locator("#sidebar")
    .getByRole("link", { name: /Favorites/ })
    .click();
  await page.mouse.move(0, 0);
  await expect(page).toHaveURL(/\/steam\//);
  const steam = page.locator('.side-item[aria-current="page"]');
  await expect(steam).toHaveText(/Favorites/);
  await expect(steam).toHaveCSS("background-color", "rgb(21, 24, 30)");
});

test("the active row keeps its treatment in the mobile drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.url);
  await page.getByRole("button", { name: "Open navigation" }).click();

  const active = page.locator('.side-item[aria-current="page"]');
  await expect(active).toBeVisible();
  await expect(active).toHaveCSS("background-color", "rgb(21, 24, 30)");
  await expect(active).toHaveCSS("box-shadow", /rgb\(242, 181, 68\) 3px 0px 0px 0px inset/);
});
