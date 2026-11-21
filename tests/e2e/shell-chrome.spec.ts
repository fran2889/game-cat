import { expect, test } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

/**
 * Shell chrome parity (#88): the sidebar and top bar draw every icon from
 * @tabler/icons-react, and the sidebar uses the mockup's compact row and
 * section metrics.
 */

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

const TEXT_GLYPHS = /[▤✓✦🔒⌕▦☰↑↓×+●]/u;

test("the shell renders icons instead of text glyphs and names its controls with visible labels", async ({
  page,
}) => {
  await page.goto(app.url);
  await expect(page.locator(".game-card").first()).toBeVisible();

  expect(await page.locator("#sidebar").innerText()).not.toMatch(TEXT_GLYPHS);
  expect(await page.locator(".topbar").innerText()).not.toMatch(TEXT_GLYPHS);
  // innerHTML also covers attributes such as aria-label, so a glyph cannot
  // creep back in through an accessible name.
  expect(await page.locator("#sidebar").innerHTML()).not.toMatch(TEXT_GLYPHS);
  expect(await page.locator(".topbar").innerHTML()).not.toMatch(TEXT_GLYPHS);

  // Brand, rows, section actions, and the status-card action all use the icon
  // package. The close control is hidden on desktop but stays in the DOM.
  await expect(page.locator(".brand > :first-child svg")).toHaveCount(1);
  await expect(page.locator(".brand .sidebar-close svg")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "New Smart Collection" }).locator("svg")).toHaveCount(
    1,
  );
  await expect(page.locator('.side-item[href="/"] svg')).toHaveCount(1);
  await expect(page.locator('.side-item[href="/installed"] svg')).toHaveCount(1);
  await expect(page.locator('#sidebar a[href^="/steam/"] svg')).toHaveCount(1);
  await expect(page.locator("#steam-heading").locator("..").locator("svg")).toHaveCount(1);
  await expect(
    page.locator(".status-card").getByRole("button", { name: "Fetch" }).locator("svg"),
  ).toHaveCount(1);

  // Top-bar controls keep their names while their glyphs become icons.
  await expect(page.locator(".mobile-menu svg")).toHaveCount(1);
  await expect(page.locator(".search-wrap svg")).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Sort by" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sort ascending" }).locator("svg")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Grid view" }).locator("svg")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Table view" }).locator("svg")).toHaveCount(1);
  await expect(page.locator(".toggle-button")).toHaveCount(1);
  // The check glyph became an icon; the accessible name matches the visible
  // label rather than retaining the old symbol.
  await expect(page.locator(".toggle-button")).toHaveAccessibleName("Installed");
  await expect(page.locator(".toggle-button").locator("svg")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "New collection" })).toHaveAccessibleName(
    "New collection",
  );
  await expect(page.getByRole("link", { name: "New collection" }).locator("svg")).toHaveCount(1);

  const search = page.getByRole("searchbox", { name: "Search game names" });
  await search.fill("portal");
  await expect(page.getByRole("button", { name: "Clear search" }).locator("svg")).toHaveCount(1);
});

test("the sidebar matches the mockup's row, section, brand, and type metrics", async ({ page }) => {
  await page.goto(app.url);
  await expect(page.locator(".game-card").first()).toBeVisible();

  const row = page.locator(".side-item").first();
  await expect(row).toHaveCSS("display", "grid");
  await expect(row).toHaveCSS("gap", "9px");
  await expect(row).toHaveCSS("padding", "7px 8px");
  await expect(row).toHaveCSS("border-radius", "6px");
  const columns = await row.evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(columns.split(" ")[0]).toBe("18px");

  // 8px horizontal and 4px vertical section padding.
  await expect(page.locator("#sidebar nav")).toHaveCSS("padding", "4px 8px");
  await expect(page.locator('#sidebar section[aria-labelledby="smart-heading"]')).toHaveCSS(
    "padding",
    "4px 8px",
  );
  await expect(page.locator('#sidebar section[aria-labelledby="steam-heading"]')).toHaveCSS(
    "padding",
    "4px 8px",
  );

  // Title-case source headings and normal-text counts.
  await expect(page.locator("#smart-heading")).toHaveText("Smart Collections");
  await expect(page.locator("#steam-heading")).toHaveText("Steam Collections");
  const countFont = await page
    .locator('.side-item > [data-position="right"]')
    .first()
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(countFont.toLowerCase()).not.toContain("mono");

  // A 34px cat mark with the large wordmark and the real version badge.
  await expect(page.locator(".brand > :first-child")).toHaveCSS("width", "34px");
  // Group writes its gap as a CSS variable through the CSSOM, which CSP does
  // not govern; pin the computed spacing under the real security header.
  await expect(page.locator("#sidebar .brand")).toHaveCSS("gap", "12px");
  const wordmark = page.locator(".brand").getByText("game-cat", { exact: true });
  await expect(wordmark).toHaveCSS("font-size", "18px");
  await expect(page.locator(".brand .mantine-Badge-root")).toHaveText(/^v\d+\.\d+\.\d+$/);
});
