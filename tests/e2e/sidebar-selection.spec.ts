import { expect, test, type Locator } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

let app: TestApp;

test.beforeAll(async () => {
  app = await startTestApp({ games: 3 });
  const response = await fetch(`${app.url}api/smart-collections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Fixture picks", rules: [] }),
  });
  if (!response.ok) {
    throw new Error(`Smart Collection seed failed: ${response.status} ${await response.text()}`);
  }
});

test.afterAll(async () => {
  await app?.close();
});

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

/** The dark-6 default surface and the amber inset edge from the theme. */
const ACTIVE_BACKGROUND = "rgb(21, 24, 30)";
const ACTIVE_HOVER = "rgb(27, 31, 39)";
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

  // Smart Collection rows use the same treatment.
  await page
    .locator("#sidebar")
    .getByRole("link", { name: /Fixture picks/ })
    .click();
  await page.mouse.move(0, 0);
  await expect(page).toHaveURL(/\/smart\//);
  await expectActiveRow(page.locator('.side-item[aria-current="page"]'), /Fixture picks/);

  // Steam Collection rows use the same treatment.
  await page
    .locator("#sidebar")
    .getByRole("link", { name: /Favorites/ })
    .click();
  await page.mouse.move(0, 0);
  await expect(page).toHaveURL(/\/steam\//);
  await expectActiveRow(page.locator('.side-item[aria-current="page"]'), /Favorites/);
});

test("the selected row keeps a visible hover and keyboard focus ring", async ({ page }) => {
  await page.goto(app.url);
  const active = page.locator('.side-item[aria-current="page"]');
  await expectActiveRow(active, /All games/);

  // Hovering the selected row still changes the surface, then restores it.
  await active.hover();
  await expect(active).toHaveCSS("background-color", ACTIVE_HOVER);
  await page.mouse.move(0, 0);
  await expect(active).toHaveCSS("background-color", ACTIVE_BACKGROUND);

  // Tabbing from the skip link lands on the row and shows Mantine's focus ring.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(active).toBeFocused();
  await expect(active).toHaveCSS("outline-style", "solid");
  await expect(active).toHaveCSS("outline-color", "rgb(242, 181, 68)");
});

test("the selected label and count meet AA contrast", async ({ page }) => {
  await page.goto(app.url);
  const active = page.locator('.side-item[aria-current="page"]');
  await expectActiveRow(active, /All games/);

  const ratios = await active.evaluate((row) => {
    const channels = (color: string): number[] =>
      (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const linear = (value: number): number => {
      const normalized = value / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (color: string): number => {
      const channel = channels(color);
      return (
        0.2126 * linear(channel[0] ?? 0) +
        0.7152 * linear(channel[1] ?? 0) +
        0.0722 * linear(channel[2] ?? 0)
      );
    };
    const ratio = (foreground: string, background: string): number => {
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    };

    const rowStyle = getComputedStyle(row);
    const count = row.querySelector('[data-position="right"]');
    const countColor = count === null ? rowStyle.color : getComputedStyle(count).color;
    return {
      label: ratio(rowStyle.color, rowStyle.backgroundColor),
      count: ratio(countColor, rowStyle.backgroundColor),
    };
  });

  expect(ratios.label).toBeGreaterThanOrEqual(4.5);
  expect(ratios.count).toBeGreaterThanOrEqual(4.5);
});

test("the active row keeps its treatment in the mobile drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.url);
  await page.getByRole("button", { name: "Open navigation" }).click();

  const active = page.locator('.side-item[aria-current="page"]');
  await expect(active).toBeVisible();
  await expectActiveRow(active, /All games/);
});
