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

test("the built app serves the generated theme CSS with no runtime style tags or CSP violations", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { __violations: string[] }).__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __violations: string[] }).__violations.push(event.effectiveDirective);
    });
  });

  await page.goto(app.url);
  await expect(page.locator(".game-grid .game-card").first()).toBeVisible();

  // Mantine's provider no longer injects CSS variables or global classes.
  await expect(page.locator("style[data-mantine-styles]")).toHaveCount(0);

  const variables = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      amber: style.getPropertyValue("--mantine-color-amber-5").trim(),
      amberHover: style.getPropertyValue("--mantine-color-amber-filled-hover").trim(),
      darkPage: style.getPropertyValue("--mantine-color-dark-7").trim(),
      darkSurface: style.getPropertyValue("--mantine-color-dark-6").trim(),
      border: style.getPropertyValue("--mantine-color-default-border").trim(),
      dimmed: style.getPropertyValue("--mantine-color-dimmed").trim(),
      anchor: style.getPropertyValue("--mantine-color-anchor").trim(),
    };
  });
  expect(variables).toEqual({
    amber: "#f2b544",
    amberHover: "#ffc85c",
    darkPage: "#0f1115",
    darkSurface: "#15181e",
    border: "#2a303c",
    dimmed: "#9aa3b5",
    anchor: "#f2b544",
  });

  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(15, 17, 21)");
  await expect(page.locator("#sidebar")).toHaveCSS("background-color", "rgb(21, 24, 30)");

  const primary = page.locator(".topbar button.primary");
  await expect(primary).toHaveCSS("background-color", "rgb(242, 181, 68)");
  await primary.hover();
  await expect(primary).toHaveCSS("background-color", "rgb(255, 200, 92)");

  expect(
    await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations),
  ).toEqual([]);

  // The Smart editor is the other CSP-sensitive surface. It must mount with the
  // same generated theme and without any runtime style element or violation.
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("prefix-counts")).toBeVisible();
  await expect(page.locator("style[data-mantine-styles]")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations),
  ).toEqual([]);
});
