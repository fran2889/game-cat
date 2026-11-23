import { expect, test, type Page } from "@playwright/test";
import { blockExternalRequests, startTestApp, type TestApp } from "./fixture.ts";

let app: TestApp;

async function expectNoRuntimeStyles(page: Page): Promise<void> {
  // Mantine's provider no longer injects CSS variables or global classes.
  await expect(page.locator("style[data-mantine-styles]")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations),
  ).toEqual([]);
}

test.beforeAll(async () => {
  app = await startTestApp({ games: 3 });
  app.seedDetail(620);
});

test.afterAll(async () => {
  await app?.close();
});

test.beforeEach(async ({ context }) => {
  await blockExternalRequests(context);
});

test("the built app serves the generated theme with no runtime style tags or CSP violations on any surface", async ({
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
      borderStrong: style.getPropertyValue("--game-cat-border-strong").trim(),
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
    borderStrong: "#3b4352",
  });

  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(15, 17, 21)");
  await expect(page.locator("#sidebar")).toHaveCSS("background-color", "rgb(15, 17, 21)");

  const primary = page.locator(".topbar button.primary");
  await expect(primary).toHaveCSS("background-color", "rgb(242, 181, 68)");
  await primary.hover();
  await expect(primary).toHaveCSS("background-color", "rgb(255, 200, 92)");
  await expectNoRuntimeStyles(page);

  // The Smart editor is the other CSP-sensitive surface. It must mount with the
  // same generated theme and without any runtime style element or violation.
  await page.goto(`${app.url}smart/new`);
  await expect(page.getByTestId("prefix-counts")).toBeVisible();
  await expectNoRuntimeStyles(page);

  // The detail dialog is the third CSP-sensitive surface. Open and close it
  // through the Library so its scroll lock is exercised on both edges. It used
  // to inject a runtime style sheet through react-remove-scroll.
  await page.goto(app.url);
  await page.locator('.game-card a[href^="/games/620"]').click();
  const dialog = page.locator('[role="dialog"].detail-dialog');
  await expect(dialog.getByRole("heading", { name: "Portal 2" })).toBeVisible();
  await expectNoRuntimeStyles(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expectNoRuntimeStyles(page);
});
